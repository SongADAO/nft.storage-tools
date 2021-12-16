/**
 * Get all files from a directory pack a CAR file and upload to nft.storage.
 *
 * Usage:
 *     node upload-as-car.js path/to/file
 */
import fs from "fs";
import os from "os";
import path from "path";
import { packToFs } from "ipfs-car/pack/fs";
import { CarIndexedReader } from "@ipld/car";
import dotenv from "dotenv";
import { NFTStorage } from "nft.storage";
import bytes from "bytes";
import ora from "ora";

dotenv.config();

async function main() {
  if (!process.env.API_KEY) {
    throw new Error("missing nft.storage API key");
  }

  const directoryPath = process.argv[2];
  if (!directoryPath) {
    throw new Error("missing directory argument");
  }
  const files = await fs.promises.readdir(directoryPath);

  const spinner = ora();
  const endpoint = process.env.ENDPOINT || "https://api.nft.storage";
  const storage = new NFTStorage({ token: process.env.API_KEY, endpoint });

  let promises = [];
  for (const file of files) {
    promises.push(work(spinner, `${directoryPath}/${file}`, storage, endpoint));
    if (promises.length >= 1000) {
      await Promise.all(promises);
      promises = [];
    }
  }
  if (promises) {
    await Promise.all(promises);
    promises = [];
  }
}

async function work(spinner, filePath, storage, endpoint, retries = 3) {
  // locally chunk'n'hash the file to get the CID and pack the blocks in to a CAR
  spinner.start("Packing file into CAR...");
  const carPath = path.join(
    os.tmpdir(),
    `${path.basename(filePath)}.${Date.now()}.car`
  );
  const { root } = await packToFs({ input: filePath, output: carPath });
  spinner.stopAndPersist({
    text: `Packed into CAR at: ${carPath}`,
    symbol: "🚗",
  });
  spinner.stopAndPersist({ text: `CID: ${root}`, symbol: "🆔" });
  // Check if cid is already pinned
  const status = await storage.status(root).catch((err) => null);
  // This means the cid is in the pin queue
  if (status) {
    return;
  }

  spinner.start("Reading CAR file size...");
  const stat = await fs.promises.stat(filePath);
  spinner.stopAndPersist({
    text: `CAR file size: ${bytes(stat.size)}`,
    symbol: "🏋️",
  });

  try {
    const carReader = await CarIndexedReader.fromFile(carPath);
    spinner.stopAndPersist({
      text: `Using endpoint: ${endpoint}`,
      symbol: "🔌",
    });

    const start = Date.now();
    let totalBytesSent = 0;
    spinner.start("Uploading CAR...");
    // send the CAR to nft.storage, the returned CID will match the one we created above.
    const cid = await storage.storeCar(carReader, {
      onStoredChunk: (chunkSize) => {
        totalBytesSent += chunkSize;
        spinner.text = `Uploading CAR (${bytes(totalBytesSent)} sent, ${bytes(
          totalBytesSent / ((Date.now() - start) / 1000)
        )}/s)...`;
      },
    });

    spinner.info(`CID in response (for verification): ${cid}`);
    if (root !== cid.toString()) {
      console.log(`cids do not match ${root} and ${cid}`);
      if (retries !== 0) {
        await work(spinner, filePath, storage, retries - 1);
        return;
      }
      // Add to dead file
      fs.appendFile("dead.txt", `${filePath}\n`, function (err) {
        if (err) throw err;
        console.log("Dead Saved!");
      });
    }
    // This means the cid is in the pin queue
    const status = await storage.status(cid);
    console.log("Status");
    console.log(status.status);

    spinner.succeed("Upload complete");
    spinner.info(`Check status here: ${endpoint}/check/${cid}`);
  } catch (err) {
    spinner.fail(`Error: ${err.message}`);
    throw err;
  } finally {
    // Delete temporary CAR file created
    await fs.promises.rm(carPath);
  }
}

main();
