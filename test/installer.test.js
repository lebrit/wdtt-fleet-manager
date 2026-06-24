import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('installer scripts read interactive input from the terminal', () => {
  const bootstrap = readFileSync(join(root, 'bootstrap.sh'), 'utf8');
  const installer = readFileSync(join(root, 'install.sh'), 'utf8');
  assert.match(bootstrap, /read -r choice <\/dev\/tty/);
  assert.match(bootstrap, /bash "\$TEMP_SCRIPT" "\$ACTION" <\/dev\/tty/);
  assert.match(installer, /read -r -p 'Выберите действие \[0-1\]: ' answer <\/dev\/tty/);
});
