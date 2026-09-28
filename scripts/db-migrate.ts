// Applies migrations/*.sql over the direct connection. Run with `npm run db:migrate`.
import { Client } from "@neondatabase/serverless";
import { migrate } from "../src/lib/migrate";

async function main() {
  const url = process.env.DATABASE_URL_UNPOOLED;
  if (!url) throw new Error("DATABASE_URL_UNPOOLED is not set");
  const client = new Client(url);
  await client.connect();
  try {
    const applied = await migrate({
      exec: async (sql) => {
        await client.query(sql);
      },
      query: async (text, params) => (await client.query(text, params)).rows,
    });
    const branch = process.env.NEON_BRANCH ?? "unknown";
    console.log(applied.length ? `Applied on ${branch}: ${applied.join(", ")}` : `Up to date on ${branch}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
