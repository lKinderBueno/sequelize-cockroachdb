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
const _ = require("lodash");
const Utils = require('sequelize/lib/utils');

const QueryGenerator = require('sequelize/lib/dialects/postgres/query-generator');

QueryGenerator.prototype.bulkInsertQuery = function (tableName, fieldValueHashes, options, fieldMappedAttributes) {
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
  