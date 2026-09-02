#!/usr/bin/env node
/*
 * Drydock's shell tool.
 *
 * Deleting a project is the only action in Drydock that no restore point can
 * bring back, so it is not available in the web app at all. It lives here,
 * behind shell access, and asks you to type the project name out in full.
 *
 *   docker exec -it drydock node src/cli.js list
 *   docker exec -it drydock node src/cli.js delete-project
 *   docker exec -it drydock node src/cli.js rename-user
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { db, UPLOAD_DIR, SNAPSHOT_DIR } from './db.js';

const bold = (s) => `\u001b[1m${s}\u001b[0m`;
const dim = (s) => `\u001b[2m${s}\u001b[0m`;
const red = (s) => `\u001b[31m${s}\u001b[0m`;
const amber = (s) => `\u001b[33m${s}\u001b[0m`;
const green = (s) => `\u001b[32m${s}\u001b[0m`;

function summarise(id) {
  const one = (sql) => db.prepare(sql).get(id).c;
  return {
    boards: one('SELECT COUNT(*) c FROM boards WHERE project_id = ?'),
    items: db.prepare('SELECT COUNT(*) c FROM items WHERE board_id IN (SELECT id FROM boards WHERE project_id = ?)').get(id).c,
    images: one('SELECT COUNT(*) c FROM images WHERE project_id = ?'),
    cards: db.prepare('SELECT COUNT(*) c FROM cards WHERE column_id IN (SELECT id FROM columns WHERE project_id = ?)').get(id).c,
    nodes: db.prepare('SELECT COUNT(*) c FROM nodes WHERE graph_id IN (SELECT id FROM graphs WHERE project_id = ?)').get(id).c,
    snapshots: one('SELECT COUNT(*) c FROM snapshots WHERE project_id = ?'),
  };
}

function listProjects() {
  const rows = db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all();
  if (!rows.length) {
    console.log(dim('  No projects yet.'));
    return rows;
  }
  console.log('');
  for (const p of rows) {
    const c = summarise(p.id);
    console.log(`  ${bold(p.name)}  ${dim(p.id)}`);
    console.log(dim(`    ${c.items} board items · ${c.images} images · ${c.cards} cards · ${c.nodes} story nodes · ${c.snapshots} restore points`));
  }
  console.log('');
  return rows;
}

function destroy(project) {
  const files = db.prepare('SELECT file, thumb FROM images WHERE project_id = ?').all(project.id);
  const snaps = db.prepare('SELECT file FROM snapshots WHERE project_id = ?').all(project.id);

  db.prepare('DELETE FROM projects WHERE id = ?').run(project.id);

  let removed = 0;
  for (const f of files) {
    for (const name of [f.file, f.thumb]) {
      try { fs.unlinkSync(path.join(UPLOAD_DIR, name)); removed += 1; } catch {}
    }
  }
  for (const s of snaps) {
    try { fs.unlinkSync(path.join(SNAPSHOT_DIR, s.file)); removed += 1; } catch {}
  }
  return removed;
}

async function deleteProject(nameFromArgs) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const projects = db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all();
    if (!projects.length) {
      console.log(dim('  There are no projects to delete.'));
      return 0;
    }

    let target = nameFromArgs
      ? projects.find((p) => p.name === nameFromArgs || p.id === nameFromArgs)
      : null;

    if (!target) {
      if (nameFromArgs) console.log(red(`  No project called “${nameFromArgs}”.`));
      listProjects();
      const answer = (await rl.question('  Which project? (name or id, blank to cancel) ')).trim();
      if (!answer) { console.log(dim('  Cancelled.')); return 0; }
      target = projects.find((p) => p.name === answer || p.id === answer);
      if (!target) { console.log(red('  Nothing matched that exactly.')); return 1; }
    }

    const c = summarise(target.id);
    console.log('');
    console.log(amber(`  About to permanently delete “${target.name}”.`));
    console.log(`  This removes ${c.boards} boards, ${c.items} board items, ${c.images} images,`);
    console.log(`  ${c.cards} cards, ${c.nodes} story nodes and all ${c.snapshots} restore points.`);
    console.log(red('  No restore point can bring it back afterwards.'));
    console.log('');

    const typed = await rl.question(`  Type ${bold(target.name)} to confirm: `);
    if (typed !== target.name) {
      console.log(dim('  That did not match. Nothing was deleted.'));
      return 1;
    }

    const removed = destroy(target);
    console.log(green(`\n  Deleted “${target.name}” and cleaned up ${removed} files.\n`));
    console.log(dim('  Anyone with it open will need to refresh.\n'));
    return 0;
  } finally {
    rl.close();
  }
}

const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;

function listUsers() {
  const rows = db.prepare('SELECT * FROM users ORDER BY created_at').all();
  console.log('');
  for (const u of rows) {
    const tags = [u.is_admin ? 'admin' : 'member', u.disabled ? 'disabled' : null].filter(Boolean);
    console.log(`  ${bold(u.username)}  ${dim(`${u.display_name} · ${tags.join(' · ')}`)}`);
  }
  console.log('');
  return rows;
}

async function renameUser(fromArg, toArg) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const users = db.prepare('SELECT * FROM users ORDER BY created_at').all();
    if (!users.length) { console.log(dim('  There are no accounts yet.')); return 0; }

    let target = fromArg
      ? users.find((u) => u.username.toLowerCase() === fromArg.toLowerCase() || u.id === fromArg)
      : null;

    if (!target) {
      if (fromArg) console.log(red(`  No account called “${fromArg}”.`));
      listUsers();
      const answer = (await rl.question('  Which account? (current username, blank to cancel) ')).trim();
      if (!answer) { console.log(dim('  Cancelled.')); return 0; }
      target = users.find((u) => u.username.toLowerCase() === answer.toLowerCase() || u.id === answer);
      if (!target) { console.log(red('  Nothing matched that.')); return 1; }
    }

    let next = (toArg || '').trim();
    if (!next) {
      next = (await rl.question(`  New username for ${bold(target.username)}: `)).trim();
    }
    if (!next) { console.log(dim('  Cancelled.')); return 0; }

    if (!USERNAME_RE.test(next)) {
      console.log(red('  Usernames are 3–32 characters: letters, numbers, dot, dash, underscore.'));
      return 1;
    }
    if (next.toLowerCase() === target.username.toLowerCase() && next !== target.username) {
      // only a change of case, which SQLite treats as the same name
      db.prepare('UPDATE users SET username = ? WHERE id = ?').run(next, target.id);
      console.log(green(`\n  Renamed to “${next}”.\n`));
      return 0;
    }
    const clash = db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE AND id != ?').get(next, target.id);
    if (clash) { console.log(red(`  “${next}” is already taken.`)); return 1; }

    db.prepare('UPDATE users SET username = ? WHERE id = ?').run(next, target.id);
    console.log(green(`\n  ${target.username} is now ${bold(next)}.\n`));
    console.log(dim('  Their password and everything they own are unchanged, and they stay signed in.'));
    console.log(dim('  Display name is separate — they can change that themselves under Account.\n'));
    return 0;
  } finally {
    rl.close();
  }
}

function usage() {
  console.log(`
  ${bold('Drydock')}

    node src/cli.js list                     show every project
    node src/cli.js users                    show every account
    node src/cli.js rename-user [old] [new]  change someone's login name
    node src/cli.js delete-project [name]    delete a project, for good

  From outside the container:

    docker exec -it drydock node src/cli.js delete-project
`);
}

const [command, ...rest] = process.argv.slice(2);

if (command === 'list') {
  listProjects();
  process.exit(0);
} else if (command === 'users') {
  listUsers();
  process.exit(0);
} else if (command === 'rename-user') {
  renameUser(rest[0] || null, rest[1] || null)
    .then((code) => process.exit(code))
    .catch((e) => { console.error(red(`  ${e.message}`)); process.exit(1); });
} else if (command === 'delete-project' || command === 'delete') {
  deleteProject(rest.join(' ').trim() || null)
    .then((code) => process.exit(code))
    .catch((e) => { console.error(red(`  ${e.message}`)); process.exit(1); });
} else {
  usage();
  process.exit(command ? 1 : 0);
}
