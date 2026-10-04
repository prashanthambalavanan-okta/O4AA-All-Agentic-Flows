import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { exportJWK } from 'jose';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Cache parsed private keys by file path (the agent cert, the service cert, …).
const keyCache = new Map();
// Cache the JWK form too — exportJWK is async and openid-client only needs it once.
const jwkCache = new Map();

/** Resolve a configured key path (relative paths are project-root relative). */
export function resolveKeyPath(privateKeyFile) {
  return path.isAbsolute(privateKeyFile)
    ? privateKeyFile
    : path.resolve(__dirname, '..', '..', privateKeyFile);
}

/**
 * Read a PEM private key from disk and return it as a crypto KeyObject.
 * Accepts PKCS#8 ("BEGIN PRIVATE KEY") and PKCS#1 ("BEGIN RSA PRIVATE KEY").
 */
export function loadPrivateKey(privateKeyFile) {
  if (!privateKeyFile) throw new Error('No private key file configured.');
  if (keyCache.has(privateKeyFile)) return keyCache.get(privateKeyFile);

  const file = resolveKeyPath(privateKeyFile);
  if (!fs.existsSync(file)) {
    throw new Error(`Private key not found at ${file}.`);
  }
  const pem = fs.readFileSync(file, 'utf8');
  let key;
  try {
    key = crypto.createPrivateKey(pem);
  } catch (err) {
    throw new Error(`Could not parse private key at ${file}: ${err.message}`);
  }
  if (key.asymmetricKeyType !== 'rsa') {
    throw new Error(`Private key at ${file} is '${key.asymmetricKeyType}', but RS256 requires an RSA key.`);
  }
  keyCache.set(privateKeyFile, key);
  return key;
}

/**
 * Same as loadPrivateKey, but for a PEM string supplied at runtime (the step-by-step
 * runner lets an operator paste a key instead of pointing at a file on disk). Cached on
 * the PEM's digest so repeated signings with the same pasted key don't re-parse it.
 * The PEM is never written to disk.
 */
export function loadPrivateKeyPem(pem) {
  if (!pem || !pem.trim()) throw new Error('No private key PEM supplied.');
  const cacheKey = `pem:${crypto.createHash('sha256').update(pem).digest('hex')}`;
  if (keyCache.has(cacheKey)) return keyCache.get(cacheKey);

  let key;
  try {
    key = crypto.createPrivateKey(pem);
  } catch (err) {
    throw new Error(`Could not parse the supplied private key: ${err.message}`);
  }
  if (key.asymmetricKeyType !== 'rsa') {
    throw new Error(`The supplied private key is '${key.asymmetricKeyType}', but RS256 requires an RSA key.`);
  }
  keyCache.set(cacheKey, key);
  return key;
}

/**
 * Build the private JWKS that openid-client signs private_key_jwt client
 * assertions with: `new issuer.Client(metadata, jwks)`.
 *
 * The `kid` must be the one registered on the app in Okta — openid-client copies
 * it straight into the assertion's JWS header so Okta can pick the right key.
 */
export async function privateJwks({ privateKeyFile, kid }) {
  const cacheKey = `${privateKeyFile}#${kid}`;
  if (jwkCache.has(cacheKey)) return jwkCache.get(cacheKey);

  if (!kid) {
    throw new Error(
      `No kid configured for ${privateKeyFile}. Register the public JWK in Okta and set its kid.`
    );
  }
  const jwk = await exportJWK(loadPrivateKey(privateKeyFile));
  const jwks = { keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] };
  jwkCache.set(cacheKey, jwks);
  return jwks;
}
