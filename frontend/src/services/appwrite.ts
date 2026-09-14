import { Client, Account, Databases } from "appwrite";

const APPWRITE_ENDPOINT = import.meta.env.VITE_APPWRITE_ENDPOINT || "https://syd.cloud.appwrite.io/v1";
const APPWRITE_PROJECT = import.meta.env.VITE_APPWRITE_PROJECT || "69d77850001bef04a924";

const client = new Client()
    .setEndpoint(APPWRITE_ENDPOINT)
    .setProject(APPWRITE_PROJECT);

const account = new Account(client);
const databases = new Databases(client);

export { client, account, databases };
