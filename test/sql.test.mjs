import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkSql, SqlError } from '../src/sql.mjs';

describe('checkSql accepts legitimate read-only queries', () => {
  const ok = [
    ['plain select', 'SELECT * FROM "logs"'],
    ['trailing semicolon is stripped', 'SELECT 1;'],
    ['WITH cte', 'WITH a AS (SELECT 1) SELECT * FROM a'],
    ['union', 'SELECT 1 UNION SELECT 2'],
    ['lowercase', 'select * from "logs"'],
    ['leading whitespace and newlines', '\n  SELECT *\n  FROM "logs"\n'],
    ['aggregate', 'SELECT count(*) FROM "logs" GROUP BY level'],
    ['order and limit', 'SELECT * FROM "logs" ORDER BY _timestamp DESC LIMIT 10'],
  ];
  for (const [name, sql] of ok) {
    test(name, () => assert.equal(typeof checkSql(sql), 'string'));
  }

  test('strips only the trailing semicolon', () => {
    assert.equal(checkSql('SELECT 1;'), 'SELECT 1');
    assert.equal(checkSql('  SELECT 1 ;  '), 'SELECT 1');
  });
});

describe('checkSql does not false-positive on literals or column names', () => {
  // These all contain banned keywords or metacharacters in positions where
  // they are harmless. Rejecting them would make the tool unusable for the
  // most common real task: searching log text.
  const ok = [
    ['column named created_at', 'SELECT created_at FROM "logs"'],
    ['column named update_time', 'SELECT update_time FROM "logs"'],
    ['column named deleted', 'SELECT deleted FROM "logs"'],
    ['literal containing delete', "SELECT * FROM \"logs\" WHERE msg = 'delete'"],
    ['literal containing semicolon', "SELECT * FROM \"logs\" WHERE msg = 'a;b'"],
    ['literal containing double dash', "SELECT * FROM \"logs\" WHERE msg = 'a--b'"],
    ['literal containing block comment', "SELECT * FROM \"logs\" WHERE msg = 'a/*b*/c'"],
    ['doubled-quote escape', "SELECT * FROM \"logs\" WHERE msg = 'it''s'"],
    ['LIKE pattern', "SELECT * FROM \"logs\" WHERE msg LIKE '%error%'"],
    ['quoted identifier with keyword', 'SELECT "drop" FROM "logs"'],
    ['literal with full statement inside', "SELECT * FROM \"logs\" WHERE msg = 'DROP TABLE x; --'"],
  ];
  for (const [name, sql] of ok) {
    test(name, () => assert.doesNotThrow(() => checkSql(sql)));
  }
});

describe('checkSql blocks writes and statement injection', () => {
  const blocked = [
    ['stacked drop', 'SELECT 1; DROP TABLE x'],
    ['stacked select', 'SELECT 1; SELECT 2'],
    ['newline stacked', 'SELECT 1\n; DROP TABLE x'],
    ['trailing line comment', 'SELECT 1 -- x'],
    ['block comment', 'SELECT 1 /* x */'],
    ['comment before keyword', '/* hi */ SELECT 1'],
    ['delete', 'DELETE FROM x'],
    ['insert', 'INSERT INTO x VALUES (1)'],
    ['update', 'UPDATE x SET a = 1'],
    ['drop', 'DROP TABLE x'],
    ['create as select', 'CREATE TABLE t AS SELECT 1'],
    ['truncate', 'TRUNCATE TABLE x'],
    ['grant', 'GRANT ALL ON x TO y'],
    ['set', 'SET foo = 1'],
    ['leading whitespace drop', '   DROP TABLE x'],
    ['select then update outside literal', "SELECT * FROM \"l\" WHERE a='x' UPDATE y SET z=1"],
    ['unbalanced single quote', "SELECT * FROM \"l\" WHERE a = 'x"],
    ['unbalanced double quote', 'SELECT * FROM "l'],
  ];
  for (const [name, sql] of blocked) {
    test(name, () => assert.throws(() => checkSql(sql), SqlError));
  }
});

describe('checkSql input validation', () => {
  for (const bad of [undefined, null, '', '   ', 42, {}, []]) {
    test(`rejects ${JSON.stringify(bad)}`, () => assert.throws(() => checkSql(bad), SqlError));
  }
});
