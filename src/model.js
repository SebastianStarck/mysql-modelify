import pluralize from "pluralize";
import logService from "./log-service.js";
import mysqlService from "./mysql-service.js";
import InvalidModelInputError from "./invalid-model-input-error.js";
import Relationship from "./relationship.js";
import Attribute from "./attribute.js";
import QueryBuilder from "./query-builder.js";
import _ from "lodash";

export default class Model {
  name;
  capitalizedName;
  tableName;

  fields = [];
  plainFields = [];
  updateableFields = [];
  requiredFields = [];
  hasCreatedAtTimestamp;
  hasUpdatedAtTimestamp;

  relations = new Map();
  attributes = new Map();

  constructor(name, fields) {
    this.name = pluralize.singular(name);
    this.capitalizedName = _.capitalize(this.name);
    this.tableName = name;
    this.fields = fields;
    this.plainFields = fields.map(({ Field }) => Field);

    this.hasCreatedAtTimestamp = this.plainFields.includes("created_at");
    this.hasUpdatedAtTimestamp = this.plainFields.includes("updated_at");
    this.updateableFields = _.without(
      fields.map((field) => field.Field),
      "id",
      "created_at"
    );

    this.requiredFields = fields
      .filter(mysqlService.columnIsRequired)
      .map(mysqlService.getColumnName);
  }

  async addRelationship(relationName, seniorModel, childrenModel) {
    const tableData = await mysqlService.runQuery(`DESCRIBE ${relationName}`);
    const relationship = new Relationship(
      relationName,
      tableData,
      seniorModel,
      childrenModel
    );

    this.relations.set(relationName, relationship);
    logService.logAttributeOrRelationSet(
      "relationship",
      relationName,
      this.name
    );
  }

  async addAttribute(attributeName, seniorModel) {
    const tableData = await mysqlService.runQuery(`DESCRIBE ${attributeName}`);
    this.attributes.set(
      attributeName,
      new Attribute(attributeName, tableData, seniorModel)
    );
    logService.logAttributeOrRelationSet("attribute", attributeName, this.name);
  }

  getValidFields(data) {
    return _.pick(data, this.updateableFields);
  }

  async get(id = null) {
    const query = new QueryBuilder(this).get(id);
    const data = await mysqlService.runQuery(query);
    const result = data.map(this.rawSQLToModel);

    return id ? result[0] : result;
  }

  async getLast() {
    const data = await mysqlService.runQuery(
      `SELECT * FROM ${this.tableName}
       ORDER BY id DESC
       LIMIT 1`
    );

    return data[0];
  }

  async update(id, data = {}) {
    delete data.id;
    const fieldsToUpdate = this.getValidFields(data);
    const relationsToUpdate = this.getRelationsToUpdate(data, id);

    relationsToUpdate.forEach(({ relationName, relationData }) => {
      this.relations.get(relationName).validateDataForCreate(relationData);
    });

    if (Object.keys(fieldsToUpdate).length > 0) {
      const query = new QueryBuilder(this).update(id, data);
      // TODO: Add verification on query response
      await mysqlService.runQuery(query);
    }

    relationsToUpdate.forEach(async ({ relationName, relationData }) => {
      await this.overrideExistingRelationEntries(
        id,
        this.relations.get(relationName),
        relationData
      );
    });

    return this.get(id);
  }

  async delete(id) {
    // TODO: Add verification on query response
    // TODO: Add deletion of relations are not cascaded for it
    await mysqlService.runQuery(`
      DELETE 
      FROM ${this.tableName} 
      WHERE id = ${id}
    `);

    return {
      success: true,
    };
  }

  async create(data = {}) {
    const fieldsToUpdate = this.getValidFields(data);
    const missingRequiredFields = this.requiredFields.filter(
      (field) => !Object.keys(fieldsToUpdate).includes(field)
    );
    const relationsToInsert = this.getRelationsToUpdate(data, null);

    relationsToInsert.forEach(({ relationName, relationData }) => {
      const relation = this.relations.get(relationName);

      if (!relation) {
        throw new Error(`Relation ${relationName} not found`);
      }

      relation.validateDataForCreate(relationData);
    });

    if (missingRequiredFields.length > 0) {
      throw new InvalidModelInputError(missingRequiredFields);
    }

    const query = new QueryBuilder(this).create(fieldsToUpdate);
    // TODO: Add verification on query response
    await mysqlService.runQuery(query);
    const result = await this.getLast();

    const signedRelationsData = this.signRelationsDataWithSeniorId(
      relationsToInsert,
      result.id
    );

    signedRelationsData.forEach(async ({ relationName, relationData }) => {
      await this.assignRelationData(
        this.relations.get(relationName),
        relationData
      );
    });

    return this.get(result.id);
  }

  async overrideExistingRelationEntries(id, relation, newData) {
    await mysqlService.runQuery(
      new QueryBuilder(this).deleteExistingRelation(id, relation)
    );

    return this.assignRelationData(relation, newData);
  }

  assignRelationData(relation, newData) {
    new QueryBuilder(this)
      .createRelationEntries(relation, newData)
      .forEach(async (query) => await mysqlService.runQuery(query));
  }

  rawSQLToModel = (rawOutput) => {
    const model = Object.entries(rawOutput).reduce(
      (partialModel, [key, value]) => {
        const [_firstLevelProp, secondLevelProp] = key.split(".");
        const valueShouldBeOmitted = secondLevelProp && !value;

        return valueShouldBeOmitted
          ? partialModel
          : _.set(partialModel, key, value);
      },
      {}
    );

    this.relations.forEach((relation) => {
      model[relation.tableName] = this.parseRelationCollection(
        model[relation.tableName] || []
      );
    });

    return model;
  };

  // "user_attributes": { "id": "1,2,3" ...}, => "user_attributes": [{ "id": "1"...}, { "id": "2" }...]
  parseRelationCollection(relationship) {
    return Object.entries(relationship).reduce((result, [key, value]) => {
      const parsedValue =
        value && typeof value === "object"
          ? this.parseRelationCollection(value)
          : (value || "").split(",");

      parsedValue.forEach((relationValueEntry, index) => {
        result[index] = _.set(
          result[index] || {},
          key,
          relationValueEntry || null
        );
      });

      return result;
    }, []);
  }

  getRelationsToUpdate(data, signingId = null) {
    const relationsToUpdate = Object.keys(data)
      .filter((relationName) =>
        [...this.relations.keys()].includes(relationName)
      )
      .map((relationName) => {
        return {
          relationName,
          relationData: data[relationName],
        };
      });

    return this.signRelationsDataWithSeniorId(relationsToUpdate, signingId);
  }

  signRelationsDataWithSeniorId(data, id) {
    return data.map((relation) =>
      _.set(
        relation,
        "relationData",
        relation.relationData.map((relationEntry) =>
          _.set(relationEntry, `id_${this.name}`, id)
        )
      )
    );
  }
}
