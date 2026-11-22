import { loadValidatedCollection } from './postman-tools.mjs';

const collection = await loadValidatedCollection();
console.info(`Postman v2.1 schema valid: ${collection.item.length} requests.`);
