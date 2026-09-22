export type WompiRuntimeConfig =
  | { enabled: false }
  | {
    enabled: true;
    environment: 'test' | 'production';
    baseUrl: string;
    publicKey: string;
    privateKey: string;
    integritySecret: string;
    eventsSecret: string;
  };

const REQUIRED_WHEN_ENABLED = [
  'WOMPI_PUBLIC_KEY',
  'WOMPI_PRIVATE_KEY',
  'WOMPI_INTEGRITY_SECRET',
  'WOMPI_EVENTS_SECRET',
] as const;

export function loadWompiConfig(env: NodeJS.ProcessEnv = process.env): WompiRuntimeConfig {
  const enabledValue = (env.WOMPI_ENABLED ?? 'false').trim().toLowerCase();
  if (enabledValue === 'false') return { enabled: false };
  if (enabledValue !== 'true') throw new Error('WOMPI_ENABLED_INVALID');

  const values = Object.fromEntries(REQUIRED_WHEN_ENABLED.map((name) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name}_REQUIRED`);
    return [name, value];
  })) as Record<(typeof REQUIRED_WHEN_ENABLED)[number], string>;

  const environment = env.WOMPI_ENVIRONMENT?.trim().toLowerCase() ?? 'test';
  if (environment !== 'test' && environment !== 'production') {
    throw new Error('WOMPI_ENVIRONMENT_INVALID');
  }

  const prefixes = environment === 'test'
    ? { publicKey: 'pub_test_', privateKey: 'prv_test_', integrity: 'test_integrity_', events: 'test_events_' }
    : { publicKey: 'pub_prod_', privateKey: 'prv_prod_', integrity: 'prod_integrity_', events: 'prod_events_' };
  if (!values.WOMPI_PUBLIC_KEY.startsWith(prefixes.publicKey)) throw new Error('WOMPI_PUBLIC_KEY_ENVIRONMENT_MISMATCH');
  if (!values.WOMPI_PRIVATE_KEY.startsWith(prefixes.privateKey)) throw new Error('WOMPI_PRIVATE_KEY_ENVIRONMENT_MISMATCH');
  if (!values.WOMPI_INTEGRITY_SECRET.startsWith(prefixes.integrity)) throw new Error('WOMPI_INTEGRITY_SECRET_ENVIRONMENT_MISMATCH');
  if (!values.WOMPI_EVENTS_SECRET.startsWith(prefixes.events)) throw new Error('WOMPI_EVENTS_SECRET_ENVIRONMENT_MISMATCH');

  return {
    enabled: true,
    environment,
    baseUrl: environment === 'test' ? 'https://sandbox.wompi.co/v1' : 'https://production.wompi.co/v1',
    publicKey: values.WOMPI_PUBLIC_KEY,
    privateKey: values.WOMPI_PRIVATE_KEY,
    integritySecret: values.WOMPI_INTEGRITY_SECRET,
    eventsSecret: values.WOMPI_EVENTS_SECRET,
  };
}
