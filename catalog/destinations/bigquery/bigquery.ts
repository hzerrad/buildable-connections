import { BigQuery, TableSchema } from "@google-cloud/bigquery";
import bigquery from "@google-cloud/bigquery/build/src/types";

import { AnyObject, DestinationClassI, TestConnection, Truthy } from "../../../types/destinationClassDefinition";
import { BigQuerySchemaType, IBigQueryDelete, IBigQueryInsert, IBigQueryUpdate } from "./lib/types";

import ITableFieldSchema = bigquery.ITableFieldSchema;

export class BigQueryDriver implements DestinationClassI {
  private readonly GOOGLE_SERVICE_ACCOUNT_KEY: string;

  client: BigQuery | null = null;

  GCP_PROJECT_ID: string;

  constructor({ GOOGLE_SERVICE_ACCOUNT_KEY, GCP_PROJECT_ID }: AnyObject) {
    this.GOOGLE_SERVICE_ACCOUNT_KEY = GOOGLE_SERVICE_ACCOUNT_KEY;
    this.GCP_PROJECT_ID = GCP_PROJECT_ID;
  }

  async connect(config?: AnyObject): Promise<void | Truthy> {
    const saKey = config && config.GOOGLE_SERVICE_ACCOUNT_KEY ?
      JSON.parse(config.GOOGLE_SERVICE_ACCOUNT_KEY) :
      JSON.parse(this.GOOGLE_SERVICE_ACCOUNT_KEY);

    this.client = new BigQuery({
      projectId: this.GCP_PROJECT_ID,
      credentials: saKey,
    });
  }

  async disconnect(): Promise<void | Truthy> {
    this.client = null;
  }

  async testConnection(): Promise<TestConnection> {
    if (!this.client) {
      throw new Error("Connection to BigQuery not established");
    }

    // A sample query
    const query = `SELECT name
      FROM \`bigquery-public-data.usa_names.usa_1910_2013\`
      WHERE state = 'TX'
      LIMIT 1`;

    const response = await this.client!.query(query);

    if (!response) {
      return {
        success: false,
        message: "Could not establish connection to BigQuery",
      };
    }

    return {
      success: true,
      message: "Connection established successfully",
    };
  }

  /**
   * Insert a chunk of data into BigQuery
   * @param dataset name of the dataset
   * @param table name of the table to insert into
   * @param data source data
   * @param options insertion options
   */
  async insertData({ dataset, table, data, options }: IBigQueryInsert) {
    if (!this.client) {
      throw new Error("Connection to BigQuery not established");
    }

    const bqTable = this.client.dataset(dataset).table(table);

    // check if the table exists
    try {
      await bqTable.get();
    } catch (err) {
      // TODO: table not found, store to the letters archive
      console.log(`table \`${this.GCP_PROJECT_ID}.${dataset}.${table}\` not found`);
      return null;
    }

    // attempt data insertion
    try {
      // NOTE: maybe send data to BigQuery chunk by chunk?
      return await bqTable.insert(data, options);
    } catch (err) {
      // TODO data does not match the schema, store to the letters archive
      console.log("Schema-altering action");
      return null;
    }
  }

  /**
   * Updates row(s) of data that match certain criteria from a BigQuery table
   * @param dataset name of the dataset
   * @param table name of the table to update rows from
   * @param set set of key/value pairs to update
   * @param filters criteria to match for, written as a SQL `WHERE` clause
   */
  async updateData({ dataset, table, filters, set }: IBigQueryUpdate) {
    if (!this.client) {
      throw new Error("Connection to BigQuery not established");
    }

    if (!filters || !filters.length) {
      throw new Error("BigQuery UPDATE must have a WHERE clause");
    }

    // extract table schema
    const bqTable = this.client.dataset(dataset).table(table);

    const metadata = await bqTable.getMetadata();
    const { schema } = metadata[0];

    // compose SQL query
    const updateQuery = `UPDATE \`${this.GCP_PROJECT_ID}.${dataset}.${table}\`
      SET ${BigQueryDriver.extractChangeset(set, schema)}
      WHERE ${filters}
    `;

    // execute query
    return bqTable.query(updateQuery);
  }

  /**
   * Deletes row(s) of data that match certain criteria from a BigQuery table
   * @param dataset name of the dataset
   * @param table name of the table to delete rows from
   * @param filters criteria to match for, written as a SQL `WHERE` clause
   */
  async deleteData({ dataset, table, filters }: IBigQueryDelete) {
    if (!this.client) {
      throw new Error("Connection to BigQuery not established");
    }

    if (!filters || !filters.length) {
      throw new Error("BigQuery DELETE must have a WHERE clause");
    }

    const deleteQuery = `DELETE FROM \`${this.GCP_PROJECT_ID}.${dataset}.${table}\`
        WHERE ${filters}
    `;

    await this.client.dataset(dataset).table(table).query(deleteQuery);
  }

  /**
   * Parses the passed value into a BigQuery SQL-DML compliant query string
   * @param value value to parse
   * @param fieldSchema BigQuery field schema
   * @private
   */
  private static parseValue(value: String | AnyObject, fieldSchema: ITableFieldSchema): string {
    let record: string;
    let values: string[];

    switch (fieldSchema.type as BigQuerySchemaType) {
      case "INTEGER":
      case "FLOAT":
      case "NUMERIC":
      case "BIGNUMERIC":
      case "BOOLEAN":
        return `${value}`;

      case "STRING":
      case "DATE":
      case "TIME":
      case "DATETIME":
      case "GEOGRAPHY": // value must conform to BigQuery Geography type. See https://cloud.google.com/bigquery/docs/geospatial-data
        return `"${value}"`;

      case "TIMESTAMP":
        return `timestamp("${value}")`;

      case "JSON":
        return `JSON '${JSON.stringify(value)}'`;

      case "BYTES":
        return `CAST("${value}" as BYTES)`;

      case "RECORD":
        record = "STRUCT(";

        values = Object.entries(value).map(([k, v]) => {
          const schema = fieldSchema.fields.find((f) => f.name === k);
          return BigQueryDriver.parseValue(v, schema);
        });

        record += `${values.join(",")})`;
        return record;

      default:
        throw new Error(`Unknown type: ${fieldSchema.type}`);
    }
  }

  /**
   * Extracts BigQuery SQL-DML compliant string from values that need to be updated.
   * @param set changeset
   * @param schema BigQuery table schema
   * @private
   */
  private static extractChangeset(set: string | string[] | AnyObject, schema: TableSchema): string {
    if (typeof set === "string") {
      return set;
    }

    if (Array.isArray(set)) {
      return set.join(",");
    }

    const changeset = Object.entries(set).map(([key, value]) => {
      let query = `${key}=`;
      const keySchema: ITableFieldSchema | undefined = schema.fields.find((field) => field.name === key);

      if (!keySchema) {
        throw new Error("Schema-altering update");
      }

      query += BigQueryDriver.parseValue(value, keySchema);

      return query;
    });

    return changeset.join(",");
  }
}

const getProxyDriver = (config: AnyObject) => {
  const driver = new BigQueryDriver(config);

  return new Proxy(driver, {
    get: (target, prop) => {
      if (typeof driver[prop] === "function") {
        return async (payload) => {
          try {
            await driver.connect();

            const result = await driver[prop](payload);

            await driver.disconnect();

            return result;
          } catch (err) {
            console.log("Error occurred ===> ", err);
            throw err;
          }
        };
      }

      throw new Error(`Method ${prop as string} not found`);
    },
  });
};

export default getProxyDriver;
