// SQL validation.
//
// The OpenObserve search API cannot write, so this is defense in depth rather
// than the only thing standing between a model and your data. It exists to
// catch a confused model early, with a clear message, instead of surfacing an
// opaque upstream 400.
//
// Strategy: blank out string literals first, then apply structural checks to
// what remains. Checking the raw SQL would reject legitimate queries such as
//   SELECT * FROM "logs" WHERE msg = 'delete; -- now'
// which contains a banned keyword, a semicolon and a comment marker, all
// harmlessly inside a literal.

/**
 * Statements that write or change state. Matched only outside string literals.
 * `select` and `with` are allowed; anything that mutates is not.
 */
const DENY =
  /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|copy|attach|detach|exec|execute|call|set|use|vacuum|analyze)\b/i;

export class SqlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SqlError';
  }
}

/**
 * Replace the contents of single- and double-quoted literals with empty
 * quotes, handling SQL's doubled-quote escape ('' and "").
 */
function blankLiterals(sql) {
  return sql.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
}

/**
 * Validate a single read-only statement and return it normalized.
 *
 * @param {unknown} sql
 * @returns {string} the trimmed statement, without a trailing semicolon
 */
export function checkSql(sql) {
  if (typeof sql !== 'string' || !sql.trim()) {
    throw new SqlError('sql is required and must be a non-empty string');
  }

  // Trim again after dropping the terminator so "SELECT 1 ;" does not keep a
  // trailing space.
  const statement = sql.trim().replace(/;\s*$/, '').trim();
  const bare = blankLiterals(statement);

  // A quote left over after blanking means a literal was never closed, so the
  // checks below would be reasoning about the wrong text.
  if (/['"]/.test(bare.replace(/''|""/g, ''))) {
    throw new SqlError('unbalanced quotes in sql');
  }
  if (bare.includes(';')) {
    throw new SqlError('only a single statement is allowed (remove the semicolon)');
  }
  if (/--|\/\*|\*\//.test(bare)) {
    throw new SqlError('SQL comments are not allowed outside string literals');
  }
  if (!/^\s*(select|with)\b/i.test(bare)) {
    throw new SqlError('only SELECT / WITH queries are allowed');
  }

  const banned = bare.match(DENY);
  if (banned) {
    throw new SqlError(
      `keyword not allowed outside a string literal: ${banned[1].toUpperCase()}. This server is read-only.`,
    );
  }

  return statement;
}
