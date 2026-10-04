// Usage: npm run hash-secret -- <secret>   → prints the value to store for an OAuth client.
import { hashSecret } from '../src/core/auth/secret-hash.js';

const secret = process.argv[2];
if (!secret) {
  console.error('Usage: npm run hash-secret -- <secret>');
  process.exit(1);
}
console.log(await hashSecret(secret));
