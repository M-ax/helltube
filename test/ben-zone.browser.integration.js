import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {start, until} from './helpers.js';
import {BEN_ZONE_ID} from '../server/ben-zone.js';

test('automatic room shows its mix and catalog, skips tracks, and returns to idle after navigation', {timeout: 30000}, async t => {
  const {instance, url} = await start(t, {maxTranscoders: 0});
  const discovery = t.mock.method(instance.youtube, 'liveStreams', async () => [
    {id: 'aaaaaaaaaaa', channel: 'PAW Patrol', title: 'Pups live', url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa'},
    {id: 'bbbbbbbbbbb', channel: 'Bluey', title: 'Bluey live', url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb'},
  ]);
  const browser = await chromium.launch({channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader']});
  t.after(() => browser.close());
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.getByLabel('Username', {exact: true}).fill('admin');
  await page.getByLabel('Password', {exact: true}).fill('garbageTime_');
  await page.getByRole('button', {name: 'Enter Helltube'}).click();
  const navigation = page.getByRole('navigation', {name: 'Screening rooms'});
  await navigation.waitFor();
  assert.equal(discovery.mock.callCount(), 0, 'The lobby does not wake the channel.');
  await navigation.getByRole('button', {name: /^The Ben Zone /}).click();
  const panel = page.getByRole('complementary', {name: 'The Ben Zone automatic channel'});
  await panel.getByRole('button', {name: 'Next song', exact: true}).waitFor();
  const room = instance.rooms.get(BEN_ZONE_ID);
  await until(() => room.current);
  await panel.getByText(room.current.soundtrack.title, {exact: true}).first().waitFor();
  assert.equal(await panel.locator('.ben-zone-tracks a').count(), 8);
  assert.equal(await page.getByRole('region', {name: 'Add a video', exact: true}).count(), 0);
  assert.equal(await page.getByRole('slider', {name: 'Seek shared video'}).count(), 0);
  assert.equal(await page.getByRole('button', {name: 'Play for everyone', exact: true}).isDisabled(), true);
  const oldTrack = room.current.soundtrack.url;
  await panel.getByRole('button', {name: 'Next song', exact: true}).click();
  await until(() => room.current?.soundtrack.url !== oldTrack);
  const oldChannel = room.current.cartoon.channel;
  await panel.getByRole('button', {name: 'Next cartoon', exact: true}).click();
  await until(() => room.current?.cartoon.channel !== oldChannel);
  await page.setViewportSize({width: 390, height: 844});
  await panel.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole('button', {name: 'Open room navigation'}).click();
  await navigation.getByRole('button', {name: /^The living room /}).click();
  await until(() => room.automation.state === 'idle');
  assert.equal(room.current, null);
  assert.equal(instance.media.jobs.size, 0);
  assert.deepEqual(errors, []);
});
