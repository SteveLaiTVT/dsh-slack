import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeReactionEvent } from '../lib/transport.js'

test('normalizeReactionEvent：bot_id / bot_profile / 本 bot 标 isBot，人类不标', () => {
  const human = normalizeReactionEvent({
    type: 'reaction_added',
    user: 'U9',
    reaction: 'no_entry_sign',
    item: { channel: 'C1', ts: '100.001' },
  }, 'UBOT')
  assert.equal(human.isBot, false)
  assert.equal(human.user, 'U9')
  assert.equal(human.channel, 'C1')
  assert.equal(human.itemTs, '100.001')
  assert.equal(human.reaction, 'no_entry_sign')

  const byBotId = normalizeReactionEvent({
    user: 'UOTHER',
    bot_id: 'B123',
    reaction: 'no_entry_sign',
    item: { channel: 'C1', ts: '100.002' },
  }, 'UBOT')
  assert.equal(byBotId.isBot, true)

  const byProfile = normalizeReactionEvent({
    user: 'UOTHER2',
    bot_profile: { id: 'B999', name: 'other-bot' },
    reaction: 'no_entry_sign',
    item: { channel: 'C1', ts: '100.003' },
  }, 'UBOT')
  assert.equal(byProfile.isBot, true)

  const self = normalizeReactionEvent({
    user: 'UBOT',
    reaction: 'no_entry_sign',
    item: { channel: 'C1', ts: '100.004' },
  }, 'UBOT')
  assert.equal(self.isBot, true)
})
