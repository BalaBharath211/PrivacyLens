// indexedDB.js

const DB_NAME = 'PrivacyDashboardDB';
const DB_VERSION = 1; // Increment this number if you change the schema (object stores or indexes)

const OBJECT_STORE_TRACKERS = 'trackers';
const OBJECT_STORE_REQUESTS = 'requests';
const OBJECT_STORE_DOMAINS = 'domains';
const OBJECT_STORE_REQUEST_DATA_TYPES = 'requestDataTypes'; // For many-to-many relationship


let db; // Global variable to hold the database instance

/**
 * Opens the IndexedDB database, creating object stores if they don't exist.
 * This function should be called once to initialize the database.
 * @returns {Promise<IDBDatabase>} A promise that resolves with the database instance.
 */
function openPrivacyDashboardDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = (event) => {
            console.error("IndexedDB error:", event.target.errorCode);
            reject("Error opening DB");
        };

        request.onsuccess = (event) => {
            db = event.target.result;
            console.log("IndexedDB opened successfully.");
            resolve(db);
        };

        // This event fires if the database version changes, allowing you to upgrade schema
        request.onupgradeneeded = (event) => {
            db = event.target.result;
            console.log("IndexedDB upgrade needed. Creating/modifying object stores.");

            // Create 'trackers' object store (stores unique tracker info)
            if (!db.objectStoreNames.contains(OBJECT_STORE_TRACKERS)) {
                const trackerStore = db.createObjectStore(OBJECT_STORE_TRACKERS, { keyPath: 'id', autoIncrement: true });
                trackerStore.createIndex('url', 'url', { unique: true }); // Index for fast lookup by URL
                trackerStore.createIndex('name', 'name', { unique: false }); // Index for tracker names
            }

            // Create 'domains' object store (stores unique domain info of visited sites and trackers)
            if (!db.objectStoreNames.contains(OBJECT_STORE_DOMAINS)) {
                const domainStore = db.createObjectStore(OBJECT_STORE_DOMAINS, { keyPath: 'id', autoIncrement: true });
                domainStore.createIndex('name', 'name', { unique: true }); // Index for domain names
            }

            // Create 'requests' object store (stores individual detected tracking requests)
            if (!db.objectStoreNames.contains(OBJECT_STORE_REQUESTS)) {
                const requestStore = db.createObjectStore(OBJECT_STORE_REQUESTS, { keyPath: 'id', autoIncrement: true });
                requestStore.createIndex('timestamp', 'timestamp', { unique: false });
                requestStore.createIndex('initiatorDomainId', 'initiatorDomainId', { unique: false }); // Foreign key to domains
                requestStore.createIndex('trackerId', 'trackerId', { unique: false }); // Foreign key to trackers
                requestStore.createIndex('requestUrl', 'requestUrl', { unique: false }); // To query original request URL
                requestStore.createIndex('blocked', 'blocked', { unique: false }); // Was it blocked?
            }

            // Create 'requestDataTypes' object store (for many-to-many relationship between requests and data types)
            // Example: A request might involve 'cookies' and 'ip_address' data types.
            if (!db.objectStoreNames.contains(OBJECT_STORE_REQUEST_DATA_TYPES)) {
                const requestDataTypeStore = db.createObjectStore(OBJECT_STORE_REQUEST_DATA_TYPES, { keyPath: 'id', autoIncrement: true });
                requestDataTypeStore.createIndex('requestId', 'requestId', { unique: false });
                requestDataTypeStore.createIndex('dataType', 'dataType', { unique: false }); // e.g., 'cookies', 'ip_address', 'fingerprint'
                requestDataTypeStore.createIndex('requestId_dataType', ['requestId', 'dataType'], { unique: true }); // Composite index
            }

            console.log("IndexedDB schema upgrade complete.");
        };
    });
}

/**
 * Gets the database instance. If not open, it opens it.
 * @returns {Promise<IDBDatabase>} A promise that resolves with the database instance.
 */
async function getDB() {
    if (!db) {
        db = await openPrivacyDashboardDB();
    }
    return db;
}


// --- Generic Add/Get Functions ---

/**
 * Adds an item to an object store. If an item with a unique index already exists, it returns the existing item.
 * @param {string} storeName - The name of the object store.
 * @param {object} item - The item to add.
 * @param {string} uniqueIndexName - The name of a unique index to check for existence (e.g., 'url' for trackers, 'name' for domains).
 * @param {any} uniqueIndexValue - The value to check against the unique index.
 * @returns {Promise<object>} A promise that resolves with the added or existing item (including its keyPath ID).
 */
async function addOrGetExisting(storeName, item, uniqueIndexName = null, uniqueIndexValue = null) {
    const db = await getDB();
    const transaction = db.transaction([storeName], 'readwrite');
    const store = transaction.objectStore(storeName);

    return new Promise(async (resolve, reject) => {
        if (uniqueIndexName && uniqueIndexValue !== null) {
            const index = store.index(uniqueIndexName);
            const getRequest = index.get(uniqueIndexValue);

            getRequest.onsuccess = async (event) => {
                const existingItem = event.target.result;
                if (existingItem) {
                    resolve(existingItem); // Item already exists
                } else {
                    const addRequest = store.add(item);
                    addRequest.onsuccess = (event) => {
                        item.id = event.target.result; // Add the generated ID to the item
                        resolve(item);
                    };
                    addRequest.onerror = (event) => reject(event.target.error);
                }
            };
            getRequest.onerror = (event) => reject(event.target.error);
        } else {
            const addRequest = store.add(item);
            addRequest.onsuccess = (event) => {
                item.id = event.target.result;
                resolve(item);
            };
            addRequest.onerror = (event) => reject(event.target.error);
        }
    });
}

/**
 * Gets all items from an object store.
 * @param {string} storeName - The name of the object store.
 * @returns {Promise<Array<object>>} A promise that resolves with an array of all items.
 */
async function getAllItems(storeName) {
    const db = await getDB();
    const transaction = db.transaction([storeName], 'readonly');
    const store = transaction.objectStore(storeName);
    const request = store.getAll();

    return new Promise((resolve, reject) => {
        request.onsuccess = (event) => resolve(event.target.result);
        request.onerror = (event) => reject(event.target.error);
    });
}

/**
 * Clears all data from specified object stores.
 * @param {Array<string>} storeNames - An array of object store names to clear.
 * @returns {Promise<void>} A promise that resolves when all stores are cleared.
 */
async function clearStores(storeNames) {
    const db = await getDB();
    const transaction = db.transaction(storeNames, 'readwrite');

    return Promise.all(storeNames.map(storeName => {
        return new Promise((resolve, reject) => {
            const store = transaction.objectStore(storeName);
            const request = store.clear();
            request.onsuccess = () => resolve();
            request.onerror = (event) => reject(event.target.error);
        });
    }));
}


// Export functions for use in background.js and popup.js
export {
    openPrivacyDashboardDB,
    getDB,
    addOrGetExisting,
    getAllItems,
    clearStores,
    OBJECT_STORE_TRACKERS,
    OBJECT_STORE_REQUESTS,
    OBJECT_STORE_DOMAINS,
    OBJECT_STORE_REQUEST_DATA_TYPES
};
