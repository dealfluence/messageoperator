/**
 * Types for the ingest secret mirror, so test/secrets.test.ts can import it
 * under tsconfig's allowJs: false and pin it against src/secrets.ts.
 */
export declare const SECRET_SERVICE: string;
export declare const MASTER_KEY_ACCOUNT: string;
export declare const VOLUME_FILE: string;
export declare const BACKEND_ENV: string;
export declare function gmailSecretName(address: string): string;
export declare function defaultBackend(env?: NodeJS.ProcessEnv): string;
export declare function readMasterKeySync(
  credsDir: string,
  backend?: string,
): Buffer | null;
export declare function readVolumeSync(
  credsDir: string,
  key: Buffer | null,
): Record<string, string>;
export declare function readSecretSync(
  credsDir: string,
  name: string,
  backend?: string,
): string | null;
