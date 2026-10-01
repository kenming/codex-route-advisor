#!/usr/bin/env node

const provider = "typesafe";
const credential = "TYPESAFE_API_KEY";
const configured = Boolean(process.env[credential]?.trim());

const result = configured
  ? {
      state: "configured_unverified",
      provider,
      credential,
    }
  : {
      state: "unavailable",
      provider,
      reason: "missing_api_key",
    };

process.stdout.write(`${JSON.stringify(result)}\n`);