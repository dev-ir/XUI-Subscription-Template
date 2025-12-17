import express from "express";
import fetch from "node-fetch";
import qs from "querystring";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { toJalaali } from "jalaali-js";
import https from 'https';
import http from 'http';
import speakeasy from 'speakeasy';

const app = express();

const CONFIG_FILE_NAME = "dvhost.config";
const BROWSER_KEYWORDS = ['Mozilla', 'Chrome', 'Safari', 'Edge', 'Opera', 'Firefox', 'Trident', 'WebKit'];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const loadConfig = () => {
    const configFile = path.join(__dirname, CONFIG_FILE_NAME);
    if (!fs.existsSync(configFile)) {
        console.error("Error: Configuration file 'dvhost.config' not found!");
        process.exit(1);
    }

    return fs.readFileSync(configFile, "utf-8")
        .split("\n")
        .reduce((acc, line) => {
            const [key, value] = line.split("=").map(item => item.trim());
            if (key && value) acc[key] = value;
            return acc;
        }, {});
};

const config = loadConfig();

const {
    HOST: dvhost_host = 'localhost',
    PORT: dvhost_port = '8080',
    PATH: dvhost_path = '',
    USERNAME = '',
    PASSWORD = '',
    PROTOCOL = 'http',
    SUBSCRIPTION = '',
    PUBLIC_KEY_PATH = '',
    PRIVATE_KEY_PATH = '',
    TEMPLATE_NAME = 'default',
    DEFAULT_LANG = 'en',
    SUB_HTTP_PORT = '3000',
    SUB_HTTPS_PORT = '443',
    TELEGRAM_URL = '',
    WHATSAPP_URL = '',
    Backup_link: BACKUP_LINK = '',
    TOTP_SECRET = '',
    TWO_FACTOR = 'false'
} = config;

const convertToJalali = (timestamp) => {
    const date = new Date(timestamp);
    const { jy, jm, jd } = toJalaali(date.getFullYear(), date.getMonth() + 1, date.getDate());
    return `${jy}/${jm}/${jd}`;
};

const isBrowserRequest = (userAgent = '') =>
    BROWSER_KEYWORDS.some(keyword => userAgent.includes(keyword));

app.use(express.static(path.join(__dirname, "public")));
app.set("views", path.join(__dirname, `views/templates/${TEMPLATE_NAME}`));
app.set("view engine", "ejs");

const fetchWithRetry = async (url, options, retries = 3) => {
    try {
        const response = await fetch(url, options);
        if (!response.ok) throw new Error(`Request failed with status ${response.status}`);
        return response;
    } catch (error) {
        if (retries <= 0) throw error;
        return fetchWithRetry(url, options, retries - 1);
    }
};

app.get(`/${SUBSCRIPTION.split('/')[3]}/:subId`, async (req, res) => {
    try {
        const { subId: targetSubId } = req.params;
        const userAgent = req.headers['user-agent'] || '';

        let loginPayload = {
            username: USERNAME,
            password: PASSWORD
        };

        if (TWO_FACTOR === 'true' && TOTP_SECRET) {
            const currentTOTP = speakeasy.totp({
                secret: TOTP_SECRET,
                encoding: 'base32',
                window: 1
            });
            loginPayload.twoFactorCode = currentTOTP;
        }


        const [loginResponse, suburl_content] = await Promise.all([
            fetchWithRetry(`${PROTOCOL}://${dvhost_host}:${dvhost_port}/${dvhost_path}/login`, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: qs.stringify(loginPayload),
            }),
            fetchUrlContent(`${SUBSCRIPTION}${targetSubId}`)
        ]);

        if (!loginResponse.ok) throw new Error("Login request failed.");

        const loginResult = await loginResponse.json();
        if (!loginResult.success) throw new Error(loginResult.msg || "Login unsuccessful");

        const cookie = loginResponse.headers.get("set-cookie");
        const listResponse = await fetchWithRetry(`${PROTOCOL}://${dvhost_host}:${dvhost_port}/${dvhost_path}/panel/api/inbounds/list`, {
            method: "GET",
            headers: { cookie, "Accept": "application/json" }
        });

        const listResult = await listResponse.json();
        const foundClient = listResult.obj
            .flatMap(inbound => JSON.parse(inbound.settings).clients)
            .find(client => client.subId === targetSubId);

        if (!foundClient) return res.status(404).json({ message: "No object found with the specified subId." });

        const trafficResponse = await fetchWithRetry(
            `${PROTOCOL}://${dvhost_host}:${dvhost_port}/${dvhost_path}/panel/api/inbounds/getClientTraffics/${foundClient.email}`, {
            method: "GET",
            headers: { cookie, "Accept": "application/json" }
        });

        const trafficData = await trafficResponse.json();
        const expiryTimeJalali = convertToJalali(trafficData.obj.expiryTime);
        const suburl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;

        if (isBrowserRequest(userAgent)) {
            return res.render("sub", {
                data: {
                    ...trafficData.obj,
                    expiryTimeJalali,
                    suburl,
                    suburl_content,
                    get_backup_link: BACKUP_LINK,
                    WHATSAPP_URL,
                    TELEGRAM_URL,
                    DEFAULT_LANG
                },
            });
        }

        const combinedContent = [BACKUP_LINK, Buffer.from(suburl_content, 'base64').toString('utf-8')]
            .filter(Boolean)
            .join('\n');

        res.send(Buffer.from(combinedContent, 'utf-8').toString('base64'));
    } catch (error) {
        console.error("Error:", error.message);
        res.status(500).json({ error: error.message });
    }
});

const fetchUrlContent = async function fetchUrlContent(url) {
    try {
        const isHttps = url.startsWith('https://');
        const agent = isHttps ? new https.Agent({ rejectUnauthorized: false })
            : new http.Agent();
        const response = await fetch(url, { agent });
        if (!response.ok) {
            throw new Error(`Failed to fetch URL: ${url}, Status: ${response.status}`);
        }
        return await response.text();
    } catch (error) {
        console.error(`Error fetching URL: ${url}`, error.message);
        throw error;
    }
};

const startServers = () => {
    http.createServer(app).listen(SUB_HTTP_PORT, () => {
        console.log(`HTTP Server is running on port ${SUB_HTTP_PORT}`);
    });

    if (PUBLIC_KEY_PATH && PRIVATE_KEY_PATH &&
        fs.existsSync(PUBLIC_KEY_PATH) && fs.existsSync(PRIVATE_KEY_PATH)) {
        const options = {
            key: fs.readFileSync(PRIVATE_KEY_PATH),
            cert: fs.readFileSync(PUBLIC_KEY_PATH)
        };
        https.createServer(options, app).listen(SUB_HTTPS_PORT, () => {
            console.log(`HTTPS Server is running on port ${SUB_HTTPS_PORT}`);
        });
    } else {
        console.warn('SSL certificates not found. Only HTTP server is running.');
    }
};

startServers();
/**
 * X-UI Subscription Template Server
 * Enhanced with API endpoints for monitoring and automation
 * 
 * Original: https://github.com/dev-ir/xui-subscription-template
 * Enhanced by: @LiberSurf (https://t.me/libersurf)
 * 
 * Features:
 * - Subscription webpage with traffic/expiry display
 * - RESTful API for monitoring bots
 * - Multi-inbound traffic aggregation
 * - 2FA/TOTP support
 */

import express from "express";
import fetch from "node-fetch";
import qs from "querystring";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { toJalaali } from "jalaali-js";
import https from 'https';
import http from 'http';
import speakeasy from 'speakeasy';

const app = express();
const CONFIG_FILE_NAME = "dvhost.config";
const BROWSER_KEYWORDS = ['Mozilla', 'Chrome', 'Safari', 'Edge', 'Opera', 'Firefox', 'Trident', 'WebKit'];
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================
// Configuration Loader
// ============================================
const loadConfig = () => {
  const configFile = path.join(__dirname, CONFIG_FILE_NAME);
  if (!fs.existsSync(configFile)) {
    console.error("Error: Configuration file 'dvhost.config' not found!");
    process.exit(1);
  }

  return fs.readFileSync(configFile, "utf-8")
    .split("\n")
    .reduce((acc, line) => {
      const [key, value] = line.split("=").map(item => item.trim());
      if (key && value) acc[key] = value;
      return acc;
    }, {});
};

const config = loadConfig();
const {
  HOST: dvhost_host = 'localhost',
  PORT: dvhost_port = '8080',
  PATH: dvhost_path = '',
  USERNAME = '',
  PASSWORD = '',
  PROTOCOL = 'http',
  SUBSCRIPTION = '',
  PUBLIC_KEY_PATH = '',
  PRIVATE_KEY_PATH = '',
  TEMPLATE_NAME = 'default',
  DEFAULT_LANG = 'en',
  SUB_HTTP_PORT = '3000',
  SUB_HTTPS_PORT = '443',
  TELEGRAM_URL = '',
  WHATSAPP_URL = '',
  Backup_link: BACKUP_LINK = '',
  TOTP_SECRET = '',
  TWO_FACTOR = 'false'
} = config;

// ============================================
// Utility Functions
// ============================================

/**
 * Convert Unix timestamp to Jalali (Persian) date
 */
const convertToJalali = (timestamp) => {
  const date = new Date(timestamp);
  const { jy, jm, jd } = toJalaali(date.getFullYear(), date.getMonth() + 1, date.getDate());
  return `${jy}/${jm}/${jd}`;
};

/**
 * Check if request is from a web browser
 */
const isBrowserRequest = (userAgent = '') =>
  BROWSER_KEYWORDS.some(keyword => userAgent.includes(keyword));

/**
 * Fetch with automatic retry on failure
 */
const fetchWithRetry = async (url, options, retries = 3) => {
  try {
    const response = await fetch(url, options);
    if (!response.ok) throw new Error(`Request failed with status ${response.status}`);
    return response;
  } catch (error) {
    if (retries <= 0) throw error;
    return fetchWithRetry(url, options, retries - 1);
  }
};

/**
 * Fetch URL content with SSL support
 */
const fetchUrlContent = async function fetchUrlContent(url) {
  try {
    const isHttps = url.startsWith('https://');
    const agent = isHttps ? new https.Agent({ rejectUnauthorized: false })
      : new http.Agent();
    const response = await fetch(url, { agent });
    if (!response.ok) {
      throw new Error(`Failed to fetch URL: ${url}, Status: ${response.status}`);
    }
    return await response.text();
  } catch (error) {
    console.error(`Error fetching URL: ${url}`, error.message);
    throw error;
  }
};

// ============================================
// Traffic Aggregation Functions
// Enhanced by @LiberSurf for multi-inbound support
// ============================================

/**
 * Aggregate traffic data from multiple inbounds
 * This allows a single subscription to have traffic across multiple servers/locations
 * 
 * @param {Array} trafficArray - Array of traffic objects from different inbounds
 * @returns {Object} Aggregated traffic data with totals and percentages
 */
const aggregateTrafficData = (trafficArray) => {
  if (!Array.isArray(trafficArray) || trafficArray.length === 0) {
    return null;
  }

  // Initialize with first inbound data as base
  const aggregated = {
    ...trafficArray[0],
    up: 0,
    down: 0,
    inboundIds: [],
    inboundRemarks: [],
    inboundCount: trafficArray.length
  };

  // Sum traffic across all inbounds
  trafficArray.forEach(traffic => {
    aggregated.up += traffic.up || 0;
    aggregated.down += traffic.down || 0;
    aggregated.inboundIds.push(traffic.inboundId);
    if (traffic.inboundRemark) {
      aggregated.inboundRemarks.push(traffic.inboundRemark);
    }
  });

  // Calculate totals and percentages
  aggregated.totalUsed = aggregated.up + aggregated.down;
  aggregated.remaining = aggregated.total - aggregated.totalUsed;
  aggregated.usagePercent = aggregated.total > 0
    ? ((aggregated.totalUsed / aggregated.total) * 100).toFixed(2)
    : 0;

  return aggregated;
};

/**
 * Get aggregated traffic data for a specific subscription ID
 * Handles authentication, fetching all related clients, and aggregating their traffic
 * 
 * @param {string} targetSubId - Subscription ID to query
 * @returns {Object} Contains aggregatedData, allClientsWithSubId, and cookie
 */
const getAggregatedTrafficBySubId = async (targetSubId) => {
  // Prepare login credentials
  let loginPayload = {
    username: USERNAME,
    password: PASSWORD
  };

  // Add 2FA token if enabled
  if (TWO_FACTOR === 'true' && TOTP_SECRET) {
    const currentTOTP = speakeasy.totp({
      secret: TOTP_SECRET,
      encoding: 'base32',
      window: 1
    });
    loginPayload.twoFactorCode = currentTOTP;
  }

  // Authenticate with X-UI panel
  const loginResponse = await fetchWithRetry(`${PROTOCOL}://${dvhost_host}:${dvhost_port}/${dvhost_path}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: qs.stringify(loginPayload),
  });

  if (!loginResponse.ok) throw new Error("Login request failed.");

  const loginResult = await loginResponse.json();
  if (!loginResult.success) throw new Error(loginResult.msg || "Login unsuccessful");

  const cookie = loginResponse.headers.get("set-cookie");

  // Fetch all inbounds from panel
  const listResponse = await fetchWithRetry(`${PROTOCOL}://${dvhost_host}:${dvhost_port}/${dvhost_path}/panel/api/inbounds/list`, {
    method: "GET",
    headers: { cookie, "Accept": "application/json" }
  });

  const listResult = await listResponse.json();

  // Find ALL clients with matching subId across all inbounds
  const allClientsWithSubId = [];
  listResult.obj.forEach(inbound => {
    try {
      const clients = JSON.parse(inbound.settings).clients;
      const matchingClients = clients.filter(client => client.subId === targetSubId);
      matchingClients.forEach(client => {
        allClientsWithSubId.push({
          email: client.email,
          inboundId: inbound.id,
          inboundRemark: inbound.remark,
          clientId: client.id
        });
      });
    } catch (error) {
      console.error(`Error parsing inbound ${inbound.id}:`, error.message);
    }
  });

  if (allClientsWithSubId.length === 0) {
    throw new Error("No clients found with the specified subId.");
  }

  // Fetch traffic data for each client
  const allTrafficData = [];
  for (const client of allClientsWithSubId) {
    try {
      const trafficResponse = await fetchWithRetry(
        `${PROTOCOL}://${dvhost_host}:${dvhost_port}/${dvhost_path}/panel/api/inbounds/getClientTraffics/${client.email}`, {
        method: "GET",
        headers: { cookie, "Accept": "application/json" }
      });
      const trafficData = await trafficResponse.json();

      if (trafficData.obj) {
        const trafficWithInfo = {
          ...trafficData.obj,
          inboundId: client.inboundId,
          inboundRemark: client.inboundRemark,
          email: client.email,
          clientId: client.clientId
        };
        allTrafficData.push(trafficWithInfo);
      }
    } catch (error) {
      console.error(`Error fetching traffic for ${client.email}:`, error.message);
    }
  }

  if (allTrafficData.length === 0) {
    throw new Error("No traffic data found for this subscription.");
  }

  // Aggregate all traffic data
  const aggregatedData = aggregateTrafficData(allTrafficData);
  if (!aggregatedData) {
    throw new Error("Failed to aggregate traffic data.");
  }

  return {
    aggregatedData,
    allClientsWithSubId,
    cookie
  };
};

// ============================================
// Express Configuration
// ============================================
app.use(express.static(path.join(__dirname, "public")));
app.set("views", path.join(__dirname, `views/templates/${TEMPLATE_NAME}`));
app.set("view engine", "ejs");

// ============================================
// API Endpoints
// Added by @LiberSurf for monitoring bot integration
// Documentation: https://github.com/LiberSurf/x-ui-Subscription-bot
// ============================================

/**
 * GET /api/subscriptions
 * Returns all unique subscription IDs in the system
 * 
 * Response:
 * {
 *   "success": true,
 *   "count": 5,
 *   "subscriptions": ["user1", "user2", "user3", ...]
 * }
 */
app.get('/api/subscriptions', async (req, res) => {
  try {
    // Prepare login
    let loginPayload = {
      username: USERNAME,
      password: PASSWORD
    };

    if (TWO_FACTOR === 'true' && TOTP_SECRET) {
      const currentTOTP = speakeasy.totp({
        secret: TOTP_SECRET,
        encoding: 'base32',
        window: 1
      });
      loginPayload.twoFactorCode = currentTOTP;
    }

    // Authenticate
    const loginResponse = await fetchWithRetry(`${PROTOCOL}://${dvhost_host}:${dvhost_port}/${dvhost_path}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: qs.stringify(loginPayload),
    });

    if (!loginResponse.ok) throw new Error("Login request failed.");

    const loginResult = await loginResponse.json();
    if (!loginResult.success) throw new Error(loginResult.msg || "Login unsuccessful");

    const cookie = loginResponse.headers.get("set-cookie");

    // Fetch all inbounds
    const listResponse = await fetchWithRetry(`${PROTOCOL}://${dvhost_host}:${dvhost_port}/${dvhost_path}/panel/api/inbounds/list`, {
      method: "GET",
      headers: { cookie, "Accept": "application/json" }
    });

    const listResult = await listResponse.json();

    // Extract unique subscription IDs
    const subIds = new Set();
    listResult.obj.forEach(inbound => {
      try {
        const clients = JSON.parse(inbound.settings).clients;
        clients.forEach(client => {
          if (client.subId) {
            subIds.add(client.subId);
          }
        });
      } catch (error) {
        console.error(`Error parsing inbound ${inbound.id}:`, error.message);
      }
    });

    res.json({
      success: true,
      count: subIds.size,
      subscriptions: Array.from(subIds)
    });

  } catch (error) {
    console.error("API Error:", error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/traffic/:subId
 * Returns aggregated traffic data for a specific subscription
 * 
 * Response:
 * {
 *   "success": true,
 *   "subId": "user123",
 *   "data": {
 *     "totalUp": 519766714,
 *     "totalDown": 25701442138,
 *     "totalUsed": 26221208852,
 *     "totalLimit": 53687091200,
 *     "remaining": 27465882348,
 *     "usagePercent": 48.84,
 *     "expiryTime": 1734451200000,
 *     "enabled": true,
 *     "inboundCount": 3,
 *     "inboundRemarks": ["Germany", "UK", "France"],
 *     "clients": [...]
 *   }
 * }
 */
app.get('/api/traffic/:subId', async (req, res) => {
  try {
    const { subId: targetSubId } = req.params;
    const { aggregatedData, allClientsWithSubId } = await getAggregatedTrafficBySubId(targetSubId);

    res.json({
      success: true,
      subId: targetSubId,
      data: {
        totalUp: aggregatedData.up,
        totalDown: aggregatedData.down,
        totalUsed: aggregatedData.totalUsed,
        totalLimit: aggregatedData.total,
        remaining: aggregatedData.remaining,
        usagePercent: parseFloat(aggregatedData.usagePercent),
        expiryTime: aggregatedData.expiryTime,
        enabled: aggregatedData.enable,
        inboundCount: aggregatedData.inboundCount,
        inboundRemarks: aggregatedData.inboundRemarks,
        clients: allClientsWithSubId.map(c => ({
          email: c.email,
          inboundId: c.inboundId,
          inboundRemark: c.inboundRemark,
          clientId: c.clientId
        }))
      }
    });

  } catch (error) {
    console.error("API Error:", error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================
// Main Subscription Route
// Serves subscription page or config data
// ============================================
app.get(`/${SUBSCRIPTION.split('/')[3]}/:subId`, async (req, res) => {
  try {
    const { subId: targetSubId } = req.params;
    const userAgent = req.headers['user-agent'] || '';

    // Fetch aggregated data and subscription content in parallel
    const [result, suburl_content] = await Promise.all([
      getAggregatedTrafficBySubId(targetSubId),
      fetchUrlContent(`${SUBSCRIPTION}${targetSubId}`)
    ]);

    const { aggregatedData, allClientsWithSubId } = result;

    // Debug logging
    console.log("=== DEBUG: Found Clients ===");
    console.log("SubId:", targetSubId);
    console.log("Total clients found:", allClientsWithSubId.length);
    allClientsWithSubId.forEach(c => {
      console.log(` - Email: ${c.email}, Inbound: ${c.inboundRemark} (ID: ${c.inboundId})`);
    });
    console.log("============================");

    console.log("=== DEBUG: Aggregated Result ===");
    const totalGB = (aggregatedData.totalUsed / 1024 / 1024 / 1024).toFixed(2);
    const limitGB = (aggregatedData.total / 1024 / 1024 / 1024).toFixed(2);
    console.log(`Total Usage: ${totalGB}GB / ${limitGB}GB (${aggregatedData.usagePercent}%)`);
    console.log("================================");

    const expiryTimeJalali = convertToJalali(aggregatedData.expiryTime);
    const suburl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;

    // If browser request, render HTML page
    if (isBrowserRequest(userAgent)) {
      return res.render("sub", {
        data: {
          ...aggregatedData,
          expiryTimeJalali,
          suburl,
          suburl_content,
          get_backup_link: BACKUP_LINK,
          WHATSAPP_URL,
          TELEGRAM_URL,
          DEFAULT_LANG
        },
      });
    }

    // Otherwise return base64 config for VPN clients
    const combinedContent = [BACKUP_LINK, Buffer.from(suburl_content, 'base64').toString('utf-8')]
      .filter(Boolean)
      .join('\n');
    res.send(Buffer.from(combinedContent, 'utf-8').toString('base64'));

  } catch (error) {
    console.error("Error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// Server Startup
// ============================================
const startServers = () => {
  // Start HTTP server
  http.createServer(app).listen(SUB_HTTP_PORT, () => {
    console.log(`HTTP Server is running on port ${SUB_HTTP_PORT}`);
  });

  // Start HTTPS server if certificates are available
  if (PUBLIC_KEY_PATH && PRIVATE_KEY_PATH &&
    fs.existsSync(PUBLIC_KEY_PATH) && fs.existsSync(PRIVATE_KEY_PATH)) {
    const options = {
      key: fs.readFileSync(PRIVATE_KEY_PATH),
      cert: fs.readFileSync(PUBLIC_KEY_PATH)
    };
    https.createServer(options, app).listen(SUB_HTTPS_PORT, () => {
      console.log(`HTTPS Server is running on port ${SUB_HTTPS_PORT}`);
    });
  } else {
    console.warn('SSL certificates not found. Only HTTP server is running.');
  }
};

startServers();
