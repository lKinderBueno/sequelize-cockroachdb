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

const { QueryInterface } = require('sequelize/lib/dialects/abstract/query-interface');
const QueryTypes = require("sequelize/lib/query-types");

QueryInterface.prototype.select = async function (model, tableName, optionsArg) {
  const options = __spreadProps(__spreadValues({}, optionsArg), { type: QueryTypes.SELECT, model });
  return await this.sequelize.query(this.queryGenerator.selectQuery(tableName, options, model), options);
}



QueryInterface.prototype.bulkInsert = async function (tableName, records, options, attributes) {
  options = __spreadValues({}, options);

  const modelColumnToCheck = Object.values(attributes).filter(x => {
    if (x.fieldName == "createdAt" || x.fieldName == "updatedAt" || x.fieldName == "deletedAt") return false
    return x.primaryKey == true || (x.defaultValue === undefined && x.allowNull === false)
  }).map(x => x.fieldName)

  const columnToUpdate = Object.keys(records[0])
  const canUpsert = !modelColumnToCheck.find(x => !columnToUpdate.includes(x))

  if (canUpsert)
    options.type = QueryTypes.UPSERT
  else {
    options.type = QueryTypes.INSERT;

    if (options.ignoreDuplicates !== true && !!options.updateOnDuplicate) {
      const nullColumns = Object.values(attributes).filter(x => {
        if (x.fieldName == "createdAt" || x.fieldName == "updatedAt" || x.fieldName == "deletedAt") return false
        return x.primaryKey !== true && x.allowNull === false
      }).filter(x => !columnToUpdate.includes(x.fieldName))

      nullColumns.forEach(c => {
        let value = ""
        if (c.type == "INTEGER")
          value = 0
        else if (c.type == "JSON")
          value = []

        records.forEach(item => {
          item[c.fieldName] = value
        })
      })
    }
  }

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

