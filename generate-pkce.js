import crypto from "crypto";

// Generate code verifier
const codeVerifier = crypto.randomBytes(96).toString("base64url");

// Generate code challenge from verifier
const codeChallenge = crypto
  .createHash("sha256")
  .update(codeVerifier)
  .digest("base64url");

console.log("===========================================");
console.log("Code Verifier:  ", codeVerifier);
console.log("Code Challenge: ", codeChallenge);
console.log("===========================================");
console.log("\n⚠️  Save the Code Verifier securely!");
console.log("You will need it later to exchange for an access token.\n");