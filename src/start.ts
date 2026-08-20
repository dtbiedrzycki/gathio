import mongoose from "mongoose";
import { getConfig } from "./lib/config.js";
import app from "./app.js";

const config = getConfig();

mongoose.set("strictQuery", false);
// mongoose.connect() returns a promise as of mongoose 6+ (previously it
// returned the Mongoose instance); catch it so a connection failure doesn't
// also surface as an unhandled rejection alongside the "error" event below.
mongoose.connect(config.database.mongodb_url).catch(() => {});
mongoose.connection
  .on("connected", () => {
    console.log("Mongoose connection open!");
  })
  .on("error", (err: Error) => {
    console.log(`Connection error: ${err.message}`);
  });

app.listen(config.general.port, () => {
  console.log(
    `Welcome to gathio! The app is now running on http://localhost:${config.general.port}`,
  );
});
