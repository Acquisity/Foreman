export const DISPOSABLE_DATABASE = "foreman_reporter_test";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export const disposableDatabaseUrl = (raw: string | undefined): string => {
  if (!raw) {
    throw new Error(
      `Set REPORTER_STORE_TEST_URL to the disposable loopback Postgres database ${DISPOSABLE_DATABASE}.`
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new Error("REPORTER_STORE_TEST_URL is not a database URL.", {
      cause: error,
    });
  }
  if (
    !LOOPBACK_HOSTS.has(url.hostname) ||
    url.pathname !== `/${DISPOSABLE_DATABASE}`
  ) {
    throw new Error(
      `Reporter store tests only run against a local ${DISPOSABLE_DATABASE} database.`
    );
  }
  return raw;
};
