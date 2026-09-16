import { Accounts } from '../server/auth.js';
import { StateStore } from '../server/store.js';

async function bootstrap() {
  const dataDir = process.env.DATA_DIR;
  if (!dataDir?.trim()) throw new Error('DATA_DIR is required.');

  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 130) throw new Error('Invalid initial password.');
  }
  const password = input.replace(/\r?\n$/, '');
  if (password.length < 32 || password.length > 128 || /[^a-f0-9]/i.test(password)) {
    throw new Error('Invalid initial password.');
  }

  const store = new StateStore(dataDir);
  try {
    await store.init();
    const accounts = await new Accounts(dataDir, store).init();
    for (const user of accounts.users) {
      if (user.defaultPassword) await accounts.update(user.id, { password });
    }
  } finally {
    store.close();
  }
}

try {
  await bootstrap();
  console.log('Account bootstrap complete; non-default credentials preserved.');
} catch {
  console.error('Account bootstrap failed. Check DATA_DIR, database integrity, and stdin (32–128 hexadecimal characters).');
  process.exitCode = 1;
}