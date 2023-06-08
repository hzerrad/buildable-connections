import { TokenSet, XeroClient } from "xero-node";
import axios from "axios";
import { AnyObject, DestinationClassI, TestConnection, Truthy } from "../../../types/destinationClassDefinition";
import { XeroOAuth2TokenSet } from "./lib/types";

export class XeroDriver implements DestinationClassI {
  public client: XeroClient;

  public tenantIds: string[];

  private readonly XERO_CLIENT_ID: any;

  private readonly XERO_CLIENT_SECRET: any;

  constructor({ XERO_CLIENT_ID, XERO_CLIENT_SECRET }: AnyObject) {
    this.XERO_CLIENT_ID = XERO_CLIENT_ID;
    this.XERO_CLIENT_SECRET = XERO_CLIENT_SECRET;
  }

  async connect(config?: AnyObject): Promise<void | Truthy> {
    // initialize Xero client
    this.client = new XeroClient({
      clientId: config.XERO_CLIENT_ID || this.XERO_CLIENT_ID,
      clientSecret: config.XERO_CLIENT_SECRET || this.XERO_CLIENT_SECRET,
      redirectUris: [config.oauth2.redirectUri],
      scopes: config.oauth2.scopes,
      httpTimeout: 3000,
    });

    // set up Xero OAuth2 token set
    const tokenSet: XeroOAuth2TokenSet = config.oauth2.resolved;
    this.client.setTokenSet(tokenSet as TokenSet);

    // get and save all registered tenants
    const response = await axios.get("https://api.xero.com/connections", {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenSet.access_token}`,
      },
    });
    this.tenantIds = response.data.map((item: any) => item.tenantId);
  }

  async disconnect(): Promise<void | Truthy> {
    this.tenantIds = [];
    this.client = null;
  }

  async testConnection(): Promise<TestConnection> {
    try {
      await this.client.accountingApi.getAccounts(this.tenantIds[0]);

      return {
        success: true,
        message: "Connection established successfully",
      };
    } catch (err) {
      return {
        success: false,
        message: "Could not establish connection to Xero",
      };
    }
  }

  /**
   * Perform an action on the Xero API
   * @param prop - the name of the API and method to call, e.g. accounting.getAccounts
   * @param params - the parameters to pass to the API method
   */
  async performAction(prop: string | symbol, params: any) {
    // extract api and method from prop
    const [api, method] = prop.toString().split(".");

    // create an object to store the responses for each tenant
    const responses = {};

    let targetMethod = null;
    let methodParams = null;

    switch (api) {
      case "accounting":
        // get the method from the accountingApi
        targetMethod = this.client.accountingApi[method];

        if (typeof targetMethod !== "function") {
          throw new Error(`Method ${prop as string}() for Xero not found`);
        }

        // Infer the method params from the function definition
        methodParams = (Function.prototype.toString.call(targetMethod)
          .match(/\((.*?)\)/)?.[1] || "")
          .split(",")
          .map((param) => param.trim()) as Parameters<typeof targetMethod>;
        break;

      default:
        throw new Error(`API ${api as string} for Xero not found`);
    }

    for (const tenantId of this.tenantIds) {
      // recreate the args array for each tenant
      const args = methodParams.map((param) => {
        if (param === "xeroTenantId") {
          return tenantId;
        }
        return params[param];
      });

      // call method
      try {
        responses[tenantId] = (await this.client.accountingApi[method](...args)).body;
      } catch (err) {
        responses[tenantId] = err.response;
      }
    }

    return responses;
  }
}

export default function getProxyDriver(config: AnyObject) {
  const driver = new XeroDriver(config);

  return new Proxy(driver, {
    get: (target, prop) => {
      if (prop === "tenantIds") {
        return target.tenantIds;
      }

      if (prop === "client") {
        return target.client;
      }
      // check if driver[prop] is not a function
      if (typeof target[prop] !== "function") {
        throw new Error(`Method ${prop as string}() not found`);
      }

      return async (payload, params) => {
        if (prop === "connect") {
          return driver.connect(payload || config);
        }

        if (prop === "disconnect") {
          return driver.disconnect();
        }

        if (prop === "testConnection") {
          return driver.testConnection();
        }

        try {
          await driver.connect(config || payload);

          const result = await target.performAction(payload, params);

          await driver.disconnect();

          return result;
        } catch (err) {
          console.log("Error occurred ===> ", err);
          throw err;
        }
      };
    },
  });
}