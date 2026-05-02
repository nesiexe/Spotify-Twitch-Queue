import express from "express";
import dotenv from "dotenv";
import postgres from "postgres";

const envPath = process.env.ENV_CODE;
if (!envPath) {
  throw new Error('ENV_CODE is not set');
}
dotenv.config({ path: envPath });
const app = express();

app.set("trust proxy", true);

const twitchClientId = process.env.TWITCH_CLIENT_ID;
const twitchClientSecret = process.env.TWITCH_CLIENT_SECRET;
const postgresPassword = process.env.POSTGRES_PASSWORD;

// Function to get Twitch access token
async function getTwitchAccessToken() {
    const res = await fetch(`https://id.twitch.tv/oauth2/token`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `client_id=${twitchClientId}&client_secret=${twitchClientSecret}&grant_type=client_credentials`
    });
    const data = await res.json();
    return{ 
        access_token: data.access_token ,
        expires_in: data.expires_in,
        token_type: data.token_type
    };
}

// Initialize PostgreSQL connection
const sql = postgres('postgres://nesi:${postgresPassword}@127.0.0.1:5432/twitchapidb',{
    host                 : '127.0.0.1',            // Postgres ip address[s] or domain name[s]
    port                 : 5432,          // Postgres server port[s]
    database             : 'twitchapidb',            // Name of database to connect to
    username             : 'nesi',            // Username of database user
    password             : `${postgresPassword}`,            // Password of database user
});

app.use((req, res, next) => {
  // cors
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

app.get("/api/twitch-queue", async (req, res) => {
    try {
        const token = await getTwitchAccessToken();
        res.json(token);
    } catch (err) {
        console.error('Error getting Twitch access token:', err);
        res.status(500).json({ error: 'Failed to get Twitch access token' });
    }
});

app.listen(8080, '127.0.0.1', () => {
    console.log("Server is running on http://localhost:8080");
});
