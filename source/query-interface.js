/*
FATTA DA ME. PER SELECT CON AS OF SYSTEM TIME follower_read_timestamp()
*/

"use strict";
var __defProps = Object.defineProperties;
var __defProp = Object.defineProperty;
var __getOwnPropSymbols = Object.getOwnPropertySymbols;
var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __propIsEnum = Object.prototype.propertyIsEnumerable;
var __spreadProps = (a, b) => __defProps(a, __getOwnPropDescs(b));
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
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

const { QueryInterface} = require('sequelize/lib/dialects/abstract/query-interface');
const QueryTypes = require("sequelize/lib/query-types");

QueryInterface.prototype.select = async function (model, tableName, optionsArg) {
  const options = __spreadProps(__spreadValues({}, optionsArg), { type: QueryTypes.SELECT, model });
  let _q = this.queryGenerator.selectQuery(tableName, options, model)
  if(optionsArg.compromiseConsistency === true) _q = _q.replace(";", " AS OF SYSTEM TIME follower_read_timestamp();")
  return await this.sequelize.query(_q, options);
}



QueryInterface.prototype.bulkInsert = async function (tableName, records, options, attributes) {
  options = __spreadValues({}, options);


  const modelColumnToCheck = Object.values(attributes).filter(x=>x.primaryKey == true || (x.defaultValue === undefined && x.allowNull === false)).map(x=>x.fieldName)
  const columnToUpdate = Object.keys(records[0])
  const canUpsert = !!modelColumnToCheck.find(x=>!columnToUpdate.includes(x))
  options.type = canUpsert ? QueryTypes.UPSERT : QueryTypes.INSERT;
  
  /*
  if (options.ignoreDuplicates)
    options.type = QueryTypes.INSERT;
  else {
    const modelColumnToCheck = Object.values(attributes).filter(x=>x.primaryKey == true || (x.defaultValue === undefined && x.allowNull === false)).map(x=>x.fieldName)
    const columnToUpdate = Object.keys(records[0])
    const canUpsert = !!modelColumnToCheck.find(x=>!columnToUpdate.includes(x))
    options.type = canUpsert ? QueryTypes.UPSERT : QueryTypes.INSERT;
  }
  */

  const results = await this.sequelize.query(this.queryGenerator.bulkInsertQuery(tableName, records, options, attributes), options);
  return results[0];
}


QueryInterface.prototype.bulkInsertQuery = async function (tableName, fieldValueHashes, options, fieldMappedAttributes) {
  options = options || {};
  fieldMappedAttributes = fieldMappedAttributes || {};
  const tuples = [];
  const serials = {};
  const allAttributes = [];
  let onDuplicateKeyUpdate = "";
  for (const fieldValueHash of fieldValueHashes) {
    _.forOwn(fieldValueHash, (value, key) => {
      if (!allAttributes.includes(key)) {
        allAttributes.push(key);
      }
      if (fieldMappedAttributes[key] && fieldMappedAttributes[key].autoIncrement === true) {
        serials[key] = true;
      }
    });
  }
  for (const fieldValueHash of fieldValueHashes) {
    const values = allAttributes.map((key) => {
      if (this._dialect.supports.bulkDefault && serials[key] === true) {
        return fieldValueHash[key] != null ? fieldValueHash[key] : "DEFAULT";
      }
      return this.escape(fieldValueHash[key], fieldMappedAttributes[key], { context: "INSERT" });
    });
    tuples.push(`(${values.join(",")})`);
  }

  if(options.type == "INSERT") {
    if (this._dialect.supports.inserts.updateOnDuplicate && options.updateOnDuplicate) {
      if (this._dialect.supports.inserts.updateOnDuplicate == " ON CONFLICT DO UPDATE SET") {
        const conflictKeys = options.upsertKeys.map((attr) => this.quoteIdentifier(attr));
        const updateKeys = options.updateOnDuplicate.map((attr) => `${this.quoteIdentifier(attr)}=EXCLUDED.${this.quoteIdentifier(attr)}`);
        let whereClause = false;
        if (options.conflictWhere) {
          if (!this._dialect.supports.inserts.onConflictWhere) {
            throw new Error(`conflictWhere not supported for dialect ${this._dialect.name}`);
          }
          whereClause = this.whereQuery(options.conflictWhere, options);
        }
        onDuplicateKeyUpdate = [
          "ON CONFLICT",
          "(",
          conflictKeys.join(","),
          ")",
          whereClause,
          "DO UPDATE SET",
          updateKeys.join(",")
        ];
      } else {
        if (options.conflictWhere) {
          throw new Error(`conflictWhere not supported for dialect ${this._dialect.name}`);
        }
        const valueKeys = options.updateOnDuplicate.map((attr) => `${this.quoteIdentifier(attr)}=VALUES(${this.quoteIdentifier(attr)})`);
        onDuplicateKeyUpdate = `${this._dialect.supports.inserts.updateOnDuplicate} ${valueKeys.join(",")}`;
      }
    }
  }

  
  const ignoreDuplicates = options.ignoreDuplicates ? this._dialect.supports.inserts.ignoreDuplicates : "";
  const attributes = allAttributes.map((attr) => this.quoteIdentifier(attr)).join(",");
  const onConflictDoNothing = options.ignoreDuplicates && options.type == "INSERT" ? this._dialect.supports.inserts.onConflictDoNothing : "";
  let returning = "";
  if (this._dialect.supports.returnValues && options.returning) {
    const returnValues = this.generateReturnValues(fieldMappedAttributes, options);
    returning += returnValues.returningFragment;
  }
  return Utils.joinSQLFragments([
    options.type,
    ignoreDuplicates,
    "INTO",
    this.quoteTable(tableName),
    `(${attributes})`,
    "VALUES",
    tuples.join(","),
    onDuplicateKeyUpdate,
    onConflictDoNothing,
    returning,
    ";"
  ]);
}
