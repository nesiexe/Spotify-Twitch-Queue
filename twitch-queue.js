import express from "express";
import dotenv from "dotenv";
import postgres from "postgres";

//? Remember to set allowed redirect URIs in Twitch Dev Console to http://localhost:{PublicFacingPort}/api/twitch-queue/oauth/authorize
const PublicFacingPort = 8080;
const InternalPort = 8081;

const envPath = process.env.ENV_CODE;
if (!envPath) {
  throw new Error('ENV_CODE is not set');
}
dotenv.config({ path: envPath });

const pubApp = express();             // Public-facing server for Twitch OAuth and frontend
const intApp = express();             // Internal server for admin panel API, not exposed to the public       //!DON'T EXPOSE PORT 8081 TO THE PUBLIC

intApp.set("trust proxy", true);
pubApp.set("trust proxy", true);

// Load environment variables
const twitchClientId = process.env.TWITCH_CLIENT_ID;
const twitchClientSecret = process.env.TWITCH_CLIENT_SECRET;
const postgresUser = process.env.POSTGRES_USER;
const postgresPassword = process.env.POSTGRES_PASSWORD;
const postgresDB = process.env.POSTGRES_DB;

// get user data from twitch
async function getUserInfo(accessToken) {
    console.log("Fetching user info...");
    const userinfoRes = await fetch('https://id.twitch.tv/oauth2/userinfo', {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${accessToken}`, 
        }
    });
    const userinfoData = await userinfoRes.json();
    // Don't log PII in production
    if (process.env.NODE_ENV !== 'production') {
        console.log(userinfoData);
    }
    return userinfoData;
}

// Initialize PostgreSQL connection
const sql = postgres(`postgres://${postgresUser}:${postgresPassword}@127.0.0.1:5432/${postgresDB}`,{
    host                 : '127.0.0.1',                     // Postgres ip address[s] or domain name[s]
    port                 : 5432,                            // Postgres server port[s]
    database             : `${postgresDB}`,                 // Name of database to connect to
    username             : `${postgresUser}`,               // Username of database user
    password             : `${postgresPassword}`,           // Password of database user
});

// save data to db 
async function saveUserToken(userId, username, accessToken, refreshToken) {
    await sql`
        INSERT INTO users (uid, username, access_token, refresh_token)
        VALUES (${userId}, ${username}, ${accessToken}, ${refreshToken})
        ON CONFLICT (uid) DO UPDATE
        SET access_token = ${accessToken},
            refresh_token = ${refreshToken},
            updated_at = NOW(),
            timesaccessed = users.timesaccessed + 1
    `;
}

// CORS middleware for both servers
pubApp.use((req, res, next) => {
  // cors
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

intApp.use((req, res, next) => {
    // cors
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
        return res.sendStatus(204);
    }
    next();
});


//configure routes
pubApp.get("/api/twitch-queue/auth", async (req, res) => {
    req.query.code = null;
    const redirectUri = `http://localhost:${PublicFacingPort}/api/twitch-queue/oauth/authorize`;
    const scopes = "user:read:email";
    const authUrl = `https://id.twitch.tv/oauth2/authorize?client_id=${twitchClientId}&force_verify=true&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scopes)}`;
    res.redirect(authUrl);
});

pubApp.get("/api/twitch-queue/oauth/authorize", async (req, res) => {
    const code = req.query.code;

    if (!code || typeof code !== 'string') {
        return res.status(400).json({ error: 'Invalid authorization code' });
    }

    const sanitizedCode = code.trim();

    // Basic validation to prevent potential abuse (e.g., excessively long codes or invalid characters)
    if (sanitizedCode.length > 512 || !/^[a-zA-Z0-9_\-]+$/.test(sanitizedCode)) {
        return res.status(400).json({ error: 'Invalid authorization code' });
    }

    try {
        const tokenResponse = await fetch(`https://id.twitch.tv/oauth2/token`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                client_id: twitchClientId,
                client_secret: twitchClientSecret,
                code: sanitizedCode,
                grant_type: 'authorization_code',
                redirect_uri: `http://localhost:${PublicFacingPort}/api/twitch-queue/oauth/authorize`
            })
        });

        // Check if the token exchange was successful
        if (!tokenResponse.ok) {
            const errorData = await tokenResponse.json();
            console.error('Twitch token exchange error:', errorData);
            return res.status(500).json({ error: 'Failed to exchange authorization code for access token' });
        }

        // Validate the token response structure
        const tokenData = await tokenResponse.json();
        if (!tokenData.access_token || !tokenData.refresh_token) {
            console.error('Invalid token response from Twitch:', tokenData);
            return res.status(500).json({ error: 'Invalid token response from Twitch' });
        }

        // Get user info from Twitch using the access token and save it to the database
        const userInfo = await getUserInfo(tokenData.access_token);
        if (!userInfo?.sub || !userInfo?.preferred_username) {
            return res.status(500).json({ error: 'Failed to retrieve user info from Twitch' });
        }
        
        await saveUserToken(userInfo.sub, userInfo.preferred_username, tokenData.access_token, tokenData.refresh_token);

        res.redirect(`https://card.nesiexe.xyz/`);  //? change this to something else in the future
    } catch (err) {
        console.error('Error exchanging authorization code for access token:', err);
        res.status(500).json({ error: 'Failed to exchange authorization code for access token' });
    }
});

// Endpoint to toggle user ban status
intApp.post("/api/user/:username/ban", async (req, res) => {
    const { username } = req.params;
    try {
        const rows = await sql`
            UPDATE users
            SET isbanned = NOT isbanned
            WHERE username = ${username}
            RETURNING uid, username, isbanned
        `;
        if (rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.json(rows[0]);
    } catch (err) {
        console.error('DB error:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Endpoint to get user data by username
intApp.get("/api/user/:username", async (req, res) => {
    const { username } = req.params;
    try {
        const rows = await sql`
            SELECT uid, username, display_name, timesaccessed, isbanned
            FROM users
            WHERE username = ${username}
        `;
        if (rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.json(rows[0]);
    } catch (err) {
        console.error('DB error:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Endpoint to get all users (for admin panel)
intApp.get("/api/users", async (req, res) => {
    try {
        const rows = await sql`
            SELECT uid, username, display_name, email, timesaccessed, isbanned, created_at
            FROM users
            ORDER BY created_at DESC
        `;
        res.json(rows);
    } catch (err) {
        console.error('DB error:', err);
        res.status(500).json({ error: 'Database error' });
    }
});

pubApp.listen(PublicFacingPort, '127.0.0.1', () => {
    console.log(`Front Server is running on http://localhost:${PublicFacingPort}`);
    console.log(`to auth go to http://localhost:${PublicFacingPort}/api/twitch-queue/auth`);
});

intApp.listen(InternalPort, '127.0.0.1', () => {
    console.log(`Internal Server is running on http://localhost:${InternalPort}`);
});


/*
Made by a human (Nesi) with love on Earth.
╔══════════════════════════════╗
║ Nesi.EXE               _ □ x ║
╟──────────────────────────────╢
║  __   __ ______ ______ __    ║
║ /\ "-.\ \\  ___\\  ___\\ \   ║
║ \ \ \-.  \\  __\ \___  \\ \  ║
║  \ \_\\"\_\\_____\\_____\\_\ ║
║   \/_/ \/_//_____//_____//_/ ║
║                              ║
╚══════════════════════════════╝

:3 powered
*/