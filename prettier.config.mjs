export default {
  printWidth: 100,
  semi: true,
  singleQuote: true,
  trailingComma: 'all',
  // Windows checkouts get CRLF via core.autocrlf; `.gitattributes` normalises
  // the repo to LF. "auto" keeps `--check` green regardless of local EOL.
  endOfLine: 'auto',
};
