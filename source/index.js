// Copyright 2020 The Cockroach Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
// implied. See the License for the specific language governing
// permissions and limitations under the License.

'use strict';

// Ensure the user did not forget to install Sequelize.
try {
  require('sequelize');
} catch (_) {
  throw new Error(
    'Failed to load Sequelize. Have you installed it? Run `npm install sequelize`'
  );
}

const util = require('util');
const {
  Sequelize,
  DataTypes,
  Model
} = require('sequelize');
const QueryGenerator = require('sequelize/lib/dialects/postgres/query-generator');
require('./query-interface.js')

// Ensure Sequelize version compatibility.
const version_helper = require('./version_helper.js')
const semver = require('semver');
const _ = require("lodash");

const sequelizeVersion = version_helper.GetSequelizeVersion()

if (semver.satisfies(sequelizeVersion, '<=4')) {
  throw new Error(
    `Sequelize versions 4 and below are not supported by sequelize-cockroachdb. Detected version is ${sequelizeVersion}.`
  );
}

require('./telemetry.js')

//// [1] Override the `upsert` query method from Sequelize v5 to make it work with CockroachDB
if (semver.satisfies(sequelizeVersion, '5.x')) {
  require('./patch-upsert-v5');
  require('./patches-v5');
} else {
  require('./patches-v6');
}

//// [2] Disable `EXCEPTION` support

const PostgresDialect = require('sequelize/lib/dialects/postgres/index');
// This prevents, for example, usage of CREATE/REPLACE FUNCTION when using Model.findOrCreate()
PostgresDialect.prototype.supports.EXCEPTION = false;

//// [2.1] Disable lock features support
// lockOuterJoinFailure is not supported.
PostgresDialect.prototype.supports.lockOuterJoinFailure = false;
// skipLocked is not supported.
PostgresDialect.prototype.supports.skipLocked = false;
// lockKey is not supported.
PostgresDialect.prototype.supports.lockKey = false;

//// [3] Tell Sequelize to accept large numbers as strings

// The JavaScript number type cannot represent all 64-bit integers--it can only
// exactly represent integers in the range [-2^53 + 1, 2^53 - 1]. Notably,
// CockroachDB's unique_rowid() function returns values outside the
// representable range.
//
// We must teach Sequelize's INTEGER and BIGINT types to accept stringified
// numbers instead of just raw JavaScript numbers; it's otherwise impossible to
// store a number outside the representable range into a CockroachDB INT column.
[DataTypes.postgres.INTEGER, DataTypes.postgres.BIGINT].forEach(function (
  intType
) {
  // Disable escaping so that the returned string is not wrapped in quotes
  // downstream. Valid integers cannot be dangerous, and we take care to reject
  // invalid integers.
  intType.prototype.escape = false;

  intType.prototype.$stringify = intType.prototype._stringify = function stringify(
    value
  ) {
    var rep = String(value);
    if (!/^[-+]?[0-9]+$/.test(rep)) {
      throw new Sequelize.ValidationError(
        util.format('%j is not a valid integer', value)
      );
    }
    return rep;
  };
});

// [4] Fix int to string conversion
// As pg-types says, "By default the PostgreSQL backend server returns everything as strings."
// Corrects this issue: https://github.com/cockroachdb/sequelize-cockroachdb/issues/50
const {
  ConnectionManager
} = require('sequelize/lib/dialects/abstract/connection-manager');
ConnectionManager.prototype.__loadDialectModule =
  ConnectionManager.prototype._loadDialectModule;
ConnectionManager.prototype._loadDialectModule = function (...args) {
  const pg = this.__loadDialectModule(...args);
  pg.types.setTypeParser(20, function (val) {
    if (val > Number.MAX_SAFE_INTEGER) return String(val);
    else return parseInt(val, 10);
  });
  return pg;
};

QueryGenerator.prototype.__describeTableQuery =
  QueryGenerator.prototype.describeTableQuery;
QueryGenerator.prototype.describeTableQuery = function (...args) {
  const query = this.__describeTableQuery.call(this, ...args);
  return (
    query
      // Cast integer to string to avoid concatenation error beetween string and integer
      // The || is needed to avoid replacing in the wrong place
      .replace(
        '|| c.character_maximum_length',
        '|| CAST(c.character_maximum_length AS STRING)'
      )
      // Change unimplemented table
      .replace('pg_statio_all_tables', 'pg_class')
      // Change unimplemented column
      .replace('relid', 'oid')
      // Aggregate enums in sort order
      .replace('array_agg(e.enumlabel)', 'array_agg(e.enumlabel ORDER BY e.enumsortorder ASC)')
  );
};

QueryGenerator.prototype.__fromArray = QueryGenerator.prototype.fromArray;
QueryGenerator.prototype.fromArray = function (text) {
  const patchedText = typeof text === 'string' ? text : `{${text.join(',')}}`;
  return this.__fromArray.call(this, patchedText);
};

// [5] Allow BigInts on `Model.findByPk`
// Copied from https://github.com/sequelize/sequelize/blob/29901187d9560e7d51ae1f9b5f411cf0c5d8994a/lib/model.js#L1866
// Added `bigint` to list of valid types.
// Works on v5 as well.
const Utils = require('sequelize/lib/utils');
Model.findByPk = async function findByPk(param, options) {
  // return Promise resolved with null if no arguments are passed
  if ([null, undefined].includes(param)) {
    return null;
  }

  options = Utils.cloneDeep(options) || {};

  if (typeof param === 'number' || typeof param === 'bigint' || typeof param === 'string' || Buffer.isBuffer(param)) {
    options.where = {
      [this.primaryKeyAttribute]: param
    };
  } else {
    throw new Error(`Argument passed to findByPk is invalid: ${param}`);
  }

  // Bypass a possible overloaded findOne
  // note: in v6, we don't bypass overload https://github.com/sequelize/sequelize/issues/14003
  return await this.findOne(options);
}

// [6] Skips searching for err.fields
// CRDB does not work with "details" at error level, so Sequelize does not generate this error properly.
// Copied from: https://github.com/sequelize/sequelize/blob/29901187d9560e7d51ae1f9b5f411cf0c5d8994a/lib/model.js#L2270
Model.findOrCreate = async function findOrCreate(options) {
  const _ = require('lodash');
  const Utils = require('sequelize/lib/utils');
  const {
    logger
  } = require('sequelize/lib/utils/logger');
  const sequelizeErrors = require('sequelize/lib/errors');

  if (!options || !options.where || arguments.length > 1) {
    throw new Error(
      'Missing where attribute in the options parameter passed to findOrCreate. ' +
      'Please note that the API has changed, and is now options only (an object with where, defaults keys, transaction etc.)'
    );
  }

  options = {
    ...options
  };

  if (options.defaults) {
    const defaults = Object.keys(options.defaults);
    const unknownDefaults = defaults.filter(name => !this.rawAttributes[name]);

    if (unknownDefaults.length) {
      logger.warn(`Unknown attributes (${unknownDefaults}) passed to defaults option of findOrCreate`);
    }
  }

  if (options.transaction === undefined && this.sequelize.constructor._cls) {
    const t = this.sequelize.constructor._cls.get('transaction');
    if (t) {
      options.transaction = t;
    }
  }

  const internalTransaction = !options.transaction;
  let values;
  let transaction;

  try {
    const t = await this.sequelize.transaction(options);
    transaction = t;
    options.transaction = t;

    const found = await this.findOne(Utils.defaults({
      transaction
    }, options));
    if (found !== null) {
      return [found, false];
    }

    values = {
      ...options.defaults
    };
    if (_.isPlainObject(options.where)) {
      values = Utils.defaults(values, options.where);
    }

    options.exception = true;
    options.returning = true;

    try {
      const created = await this.create(values, options);
      if (created.get(this.primaryKeyAttribute, {
        raw: true
      }) === null) {
        // If the query returned an empty result for the primary key, we know that this was actually a unique constraint violation
        throw new sequelizeErrors.UniqueConstraintError();
      }

      return [created, true];
    } catch (err) {
      if (!(err instanceof sequelizeErrors.UniqueConstraintError)) throw err;
      const flattenedWhere = Utils.flattenObjectDeep(options.where);
      const flattenedWhereKeys = Object.keys(flattenedWhere).map(name => _.last(name.split('.')));
      const whereFields = flattenedWhereKeys.map(name => _.get(this.rawAttributes, `${name}.field`, name));
      const defaultFields = options.defaults && Object.keys(options.defaults)
        .filter(name => this.rawAttributes[name])
        .map(name => this.rawAttributes[name].field || name);

      const errFieldKeys = Object.keys(err.fields || {});
      const errFieldsWhereIntersects = Utils.intersects(errFieldKeys, whereFields);
      if (defaultFields && !errFieldsWhereIntersects && Utils.intersects(errFieldKeys, defaultFields)) {
        throw err;
      }

      if (errFieldsWhereIntersects) {
        _.each(err.fields, (value, key) => {
          const name = this.fieldRawAttributesMap[key].fieldName;
          if (value.toString() !== options.where[name].toString()) {
            throw new Error(`${this.name}#findOrCreate: value used for ${name} was not equal for both the find and the create calls, '${options.where[name]}' vs '${value}'`);
          }
        });
      }

      // Someone must have created a matching instance inside the same transaction since we last did a find. Let's find it!
      const otherCreated = await this.findOne(Utils.defaults({
        transaction: internalTransaction ? null : transaction
      }, options));

      // Sanity check, ideally we caught this at the defaultFeilds/err.fields check
      // But if we didn't and instance is null, we will throw
      if (otherCreated === null) throw err;

      return [otherCreated, false];
    }
  } finally {
    if (internalTransaction && transaction) {
      await transaction.commit();
    }
  }
};


var __defProp = Object.defineProperty;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __getOwnPropSymbols = Object.getOwnPropertySymbols;
var __spreadValues = (a, b) => {
  for (var prop in b || (b = {}))
    if (__hasOwnProp.call(b, prop))
      __defNormalProp(a, prop, b[prop]);
  if (__getOwnPropSymbols)
    for (var prop of __getOwnPropSymbols(b)) {
      if (__propIsEnum.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    }
  return a;
};


Model.bulkCreate = async function bulkCreate(records, options = {}) {
  if (!records.length) {
    return [];
  }
  const dialect = this.sequelize.options.dialect;
  const now = Utils.now(this.sequelize.options.dialect);
  options = Utils.cloneDeep(options);
  if (options.transaction === void 0 && this.sequelize.constructor._cls) {
    const t = this.sequelize.constructor._cls.get("transaction");
    if (t) {
      options.transaction = t;
    }
  }
  options.model = this;
  if (!options.includeValidated) {
    this._conformIncludes(options, this);
    if (options.include) {
      this._expandIncludeAll(options);
      this._validateIncludedElements(options);
    }
  }
  const instances = records.map((values) => this.build(values, { isNewRecord: true, include: options.include }));
  const recursiveBulkCreate = async (instances2, options2) => {
    options2 = __spreadValues({
      validate: false,
      hooks: true,
      individualHooks: false,
      ignoreDuplicates: false
    }, options2);
    if (options2.returning === void 0) {
      if (options2.association) {
        options2.returning = false;
      } else {
        options2.returning = true;
      }
    }
    if (options2.ignoreDuplicates && !this.sequelize.dialect.supports.inserts.ignoreDuplicates && !this.sequelize.dialect.supports.inserts.onConflictDoNothing) {
      throw new Error(`${dialect} does not support the ignoreDuplicates option.`);
    }
    if (options2.updateOnDuplicate && (dialect !== "mysql" && dialect !== "mariadb" && dialect !== "sqlite" && dialect !== "postgres")) {
      throw new Error(`${dialect} does not support the updateOnDuplicate option.`);
    }
    const model = options2.model;
    options2.fields = options2.fields || Object.keys(model.rawAttributes);
    const createdAtAttr = model._timestampAttributes.createdAt;
    const updatedAtAttr = model._timestampAttributes.updatedAt;
    if (options2.updateOnDuplicate !== void 0) {
      if (Array.isArray(options2.updateOnDuplicate) && options2.updateOnDuplicate.length) {
        options2.updateOnDuplicate = _.intersection(_.without(Object.keys(model.tableAttributes), createdAtAttr), options2.updateOnDuplicate);
      } else {
        throw new Error("updateOnDuplicate option only supports non-empty array.");
      }
    }
    if (options2.hooks) {
      await model.runHooks("beforeBulkCreate", instances2, options2);
    }
    if (options2.validate) {
      const errors = [];
      const validateOptions = __spreadValues({}, options2);
      validateOptions.hooks = options2.individualHooks;
      await Promise.all(instances2.map(async (instance) => {
        try {
          await instance.validate(validateOptions);
        } catch (err) {
          errors.push(new sequelizeErrors.BulkRecordError(err, instance));
        }
      }));
      delete options2.skip;
      if (errors.length) {
        throw new sequelizeErrors.AggregateError(errors);
      }
    }
    if (options2.individualHooks) {
      await Promise.all(instances2.map(async (instance) => {
        const individualOptions = __spreadProps(__spreadValues({}, options2), {
          validate: false,
          hooks: true
        });
        delete individualOptions.fields;
        delete individualOptions.individualHooks;
        delete individualOptions.ignoreDuplicates;
        await instance.save(individualOptions);
      }));
    } else {
      if (options2.include && options2.include.length) {
        await Promise.all(options2.include.filter((include) => include.association instanceof BelongsTo).map(async (include) => {
          const associationInstances = [];
          const associationInstanceIndexToInstanceMap = [];
          for (const instance of instances2) {
            const associationInstance = instance.get(include.as);
            if (associationInstance) {
              associationInstances.push(associationInstance);
              associationInstanceIndexToInstanceMap.push(instance);
            }
          }
          if (!associationInstances.length) {
            return;
          }
          const includeOptions = _(Utils.cloneDeep(include)).omit(["association"]).defaults({
            transaction: options2.transaction,
            logging: options2.logging
          }).value();
          const createdAssociationInstances = await recursiveBulkCreate(associationInstances, includeOptions);
          for (const idx in createdAssociationInstances) {
            const associationInstance = createdAssociationInstances[idx];
            const instance = associationInstanceIndexToInstanceMap[idx];
            await include.association.set(instance, associationInstance, { save: false, logging: options2.logging });
          }
        }));
      }
      records = instances2.map((instance) => {
        const values = instance.dataValues;
        if (createdAtAttr && !values[createdAtAttr]) {
          values[createdAtAttr] = now;
          if (!options2.fields.includes(createdAtAttr)) {
            options2.fields.push(createdAtAttr);
          }
        }
        if (updatedAtAttr && !values[updatedAtAttr]) {
          values[updatedAtAttr] = now;
          if (!options2.fields.includes(updatedAtAttr)) {
            options2.fields.push(updatedAtAttr);
          }
        }
        const out = Utils.mapValueFieldNames(values, options2.fields, model);
        for (const key of model._virtualAttributes) {
          delete out[key];
        }
        return out;
      });
      const fieldMappedAttributes = {};
      for (const attr in model.tableAttributes) {
        fieldMappedAttributes[model.rawAttributes[attr].field || attr] = model.rawAttributes[attr];
      }
      if (options2.updateOnDuplicate) {
        options2.updateOnDuplicate = options2.updateOnDuplicate.map((attr) => model.rawAttributes[attr].field || attr);
        if (options2.conflictAttributes) {
          options2.upsertKeys = options2.conflictAttributes.map((attrName) => model.rawAttributes[attrName].field || attrName);
        } else {
          const upsertKeys = [];
          if (options2.conflictFields && options2.conflictFields.length > 0)
            upsertKeys.push(...options2.conflictFields)
          else {
            for (const i of model._indexes) {
              if (i.unique && !i.where) {
                upsertKeys.push(...i.fields);
              }
            }
            const firstUniqueKey = Object.values(model.uniqueKeys).find((c) => c.fields.length > 0);
            if (firstUniqueKey && firstUniqueKey.fields) {
              upsertKeys.push(...firstUniqueKey.fields);
            }
          }
          options2.upsertKeys = upsertKeys.length > 0 ? upsertKeys : Object.values(model.primaryKeys).map((x) => x.field);
        }
      }
      if (options2.returning && Array.isArray(options2.returning)) {
        options2.returning = options2.returning.map((attr) => _.get(model.rawAttributes[attr], "field", attr));
      }
      const results = await model.queryInterface.bulkInsert(model.getTableName(options2), records, options2, fieldMappedAttributes);
      if (Array.isArray(results)) {
        results.forEach((result, i) => {
          const instance = instances2[i];
          for (const key in result) {
            if (!instance || key === model.primaryKeyAttribute && instance.get(model.primaryKeyAttribute) && ["mysql", "mariadb", "sqlite"].includes(dialect)) {
              continue;
            }
            if (Object.prototype.hasOwnProperty.call(result, key)) {
              const record = result[key];
              const attr = _.find(model.rawAttributes, (attribute) => attribute.fieldName === key || attribute.field === key);
              instance.dataValues[attr && attr.fieldName || key] = record;
            }
          }
        });
      }
    }
    if (options2.include && options2.include.length) {
      await Promise.all(options2.include.filter((include) => !(include.association instanceof BelongsTo || include.parent && include.parent.association instanceof BelongsToMany)).map(async (include) => {
        const associationInstances = [];
        const associationInstanceIndexToInstanceMap = [];
        for (const instance of instances2) {
          let associated = instance.get(include.as);
          if (!Array.isArray(associated))
            associated = [associated];
          for (const associationInstance of associated) {
            if (associationInstance) {
              if (!(include.association instanceof BelongsToMany)) {
                associationInstance.set(include.association.foreignKey, instance.get(include.association.sourceKey || instance.constructor.primaryKeyAttribute, { raw: true }), { raw: true });
                Object.assign(associationInstance, include.association.scope);
              }
              associationInstances.push(associationInstance);
              associationInstanceIndexToInstanceMap.push(instance);
            }
          }
        }
        if (!associationInstances.length) {
          return;
        }
        const includeOptions = _(Utils.cloneDeep(include)).omit(["association"]).defaults({
          transaction: options2.transaction,
          logging: options2.logging
        }).value();
        const createdAssociationInstances = await recursiveBulkCreate(associationInstances, includeOptions);
        if (include.association instanceof BelongsToMany) {
          const valueSets = [];
          for (const idx in createdAssociationInstances) {
            const associationInstance = createdAssociationInstances[idx];
            const instance = associationInstanceIndexToInstanceMap[idx];
            const values = __spreadValues({
              [include.association.foreignKey]: instance.get(instance.constructor.primaryKeyAttribute, { raw: true }),
              [include.association.otherKey]: associationInstance.get(associationInstance.constructor.primaryKeyAttribute, { raw: true })
            }, include.association.through.scope);
            if (associationInstance[include.association.through.model.name]) {
              for (const attr of Object.keys(include.association.through.model.rawAttributes)) {
                if (include.association.through.model.rawAttributes[attr]._autoGenerated || attr === include.association.foreignKey || attr === include.association.otherKey || typeof associationInstance[include.association.through.model.name][attr] === "undefined") {
                  continue;
                }
                values[attr] = associationInstance[include.association.through.model.name][attr];
              }
            }
            valueSets.push(values);
          }
          const throughOptions = _(Utils.cloneDeep(include)).omit(["association", "attributes"]).defaults({
            transaction: options2.transaction,
            logging: options2.logging
          }).value();
          throughOptions.model = include.association.throughModel;
          const throughInstances = include.association.throughModel.bulkBuild(valueSets, throughOptions);
          await recursiveBulkCreate(throughInstances, throughOptions);
        }
      }));
    }
    instances2.forEach((instance) => {
      for (const attr in model.rawAttributes) {
        if (model.rawAttributes[attr].field && instance.dataValues[model.rawAttributes[attr].field] !== void 0 && model.rawAttributes[attr].field !== attr) {
          instance.dataValues[attr] = instance.dataValues[model.rawAttributes[attr].field];
          delete instance.dataValues[model.rawAttributes[attr].field];
        }
        instance._previousDataValues[attr] = instance.dataValues[attr];
        instance.changed(attr, false);
      }
      instance.isNewRecord = false;
    });
    if (options2.hooks) {
      await model.runHooks("afterBulkCreate", instances2, options2);
    }
    return instances2;
  };
  return await recursiveBulkCreate(instances, options);
}



// [7] GEOGRAPHY type
// Got to explicitly cast it is a GEOGRAPHY type.
DataTypes.postgres.GEOGRAPHY.prototype.bindParam = (value, options) => {
  return `ST_GeomFromGeoJSON(${options.bindParam(value)}::json)::geography`;
}

//// Done!

Sequelize.supportsCockroachDB = true;
module.exports = require('sequelize');