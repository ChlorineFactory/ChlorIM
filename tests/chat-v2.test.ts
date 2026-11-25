import { expect, test, vi } from 'vitest'
import type { Channel, ChannelFile, Message, MessagePage, ReactionSummary, SearchHit, Bookmark } from '@chiorim/shared'
import { client, harness } from './support.js'

test('updates per-member channel preferences and reads, then leaves and deletes channels with scoped events', async () => {
  const h = await harness()
  const owner = await h.person('owner')
  const guest = await h.person('guest', await h.invite(owner.token))
  const room = await h.api<Channel>('POST', '/api/channels', owner.token, {
    type: 'private', name: 'Room', member_ids: [guest.user.id],
  }, 201)
  const path = '/api/channels/' + room.id
  const wsGuest = client(h.wsUrl, guest.token)
  const wsOwner = client(h.wsUrl, owner.token)
  await vi.waitFor(() => expect(wsGuest.events[0]?.type).toBe('ready'))
  await vi.waitFor(() => expect(wsOwner.events[0]?.type).toBe('ready'))
  expect(await h.api('PATCH', path, owner.token, { system_context: 'Team instructions' })).toMatchObject({ system_context: 'Team instructions' })
  await h.api('POST', path + '/messages', owner.token, { content: 'Unread' }, 201)
  expect(await h.api('PATCH', path + '/preferences', guest.token, { muted: true })).toMatchObject({ muted: true, unread_count: 1 })
  expect((await h.api<Channel[]>('GET', '/api/channels', owner.token)).find(channel => channel.id === room.id)?.muted).toBe(false)
  await h.api('POST', '/api/channels/read-all', guest.token)
  await vi.waitFor(() => expect(wsGuest.events).toContainEqual(expect.objectContaining({
    type: 'channel.updated', channel: expect.objectContaining({ id: room.id, unread_count: 0, muted: true }),
  })))
  await h.api('POST', path + '/leave', owner.token, undefined, 400)
  await h.api('DELETE', path, guest.token, undefined, 403)
  await h.api('POST', path + '/leave', guest.token)
  await vi.waitFor(() => {
    expect(wsGuest.events).toContainEqual({ type: 'channel.removed', channel_id: room.id })
    expect(wsOwner.events).toContainEqual(expect.objectContaining({
      type: 'channel.updated', channel: expect.objectContaining({ id: room.id, member_count: 1 }),
    }))
  })
  await h.api('GET', path + '/messages', guest.token, undefined, 404)
  await h.api('DELETE', path, owner.token)
  await vi.waitFor(() => expect(wsOwner.events).toContainEqual({ type: 'channel.removed', channel_id: room.id }))
  await h.api('GET', path + '/messages', owner.token, undefined, 404)
  const dm = await h.api<Channel>('POST', '/api/channels/dm', owner.token, { target_user_id: guest.user.id })
  await h.api('DELETE', '/api/channels/' + dm.id, owner.token, undefined, 400)
  await h.api('POST', '/api/channels/' + dm.id + '/leave', guest.token, undefined, 400)
})

test('hydrates REST and WebSocket quotes, aggregates reactions and synchronizes multiple pins', async () => {
  const h = await harness()
  const owner = await h.person('owner')
  const guest = await h.person('guest', await h.invite(owner.token))
  const room = await h.general(owner.token)
  const path = '/api/channels/' + room.id
  const live = client(h.wsUrl, guest.token)
  await vi.waitFor(() => expect(live.events[0]?.type).toBe('ready'))
  const first = await h.api<Message>('POST', path + '/messages', owner.token, { content: 'First' }, 201)
  const second = await h.api<Message>('POST', path + '/messages', owner.token, { content: 'Second', reply_to_id: first.id }, 201)
  expect(second.reply_to).toMatchObject({ id: first.id, author_username: 'owner', content: 'First' })
  live.ws.send(JSON.stringify({ type: 'message.send', channel_id: room.id, thread_root_id: first.id, reply_to_id: second.id, content: 'Via WS' }))
  await vi.waitFor(() => expect(live.events).toContainEqual(expect.objectContaining({
    type: 'message.created', message: expect.objectContaining({ reply_to: expect.objectContaining({ id: second.id }) }),
  })))
  const reaction = '/api/messages/' + second.id + '/reactions'
  await h.api('POST', reaction, owner.token, { emoji: '👍' })
  const { reactions } = await h.api<{ reactions: ReactionSummary[] }>('POST', reaction, guest.token, { emoji: '👍' })
  expect(reactions).toEqual([expect.objectContaining({ emoji: '👍', count: 2, user_ids: expect.arrayContaining([owner.user.id, guest.user.id]) })])
  await vi.waitFor(() => expect(live.events).toContainEqual({
    type: 'message.reactions', channel_id: room.id, message_id: second.id, reactions,
  }))
  expect(await h.api('POST', reaction, guest.token, { emoji: '👍' })).toEqual({ reactions: [{ emoji: '👍', count: 1, user_ids: [owner.user.id] }] })

  await h.api('POST', path + '/pins', guest.token, { message_id: first.id }, 403)
  await h.api('POST', path + '/pins', owner.token, { message_id: first.id })
  await h.api('POST', path + '/pins', owner.token, { message_id: second.id })
  expect(await h.api('POST', path + '/pins', owner.token, { message_id: first.id })).toMatchObject({
    pinned_message_id: second.id, pinned_count: 2,
  })
  expect((await h.api<Message[]>('GET', path + '/pins', guest.token)).map(row => row.id)).toEqual([second.id, first.id])
  await h.api('DELETE', path + '/pins/' + second.id, owner.token)
  expect((await h.general(owner.token)).pinned_message_id).toBe(first.id)
  await h.api('PATCH', path, owner.token, { pinned_message_id: second.id })
  await h.api('DELETE', '/api/messages/' + second.id, owner.token)
  expect(await h.general(owner.token)).toMatchObject({ pinned_message_id: first.id, pinned_count: 1 })
  await h.api('PATCH', path, owner.token, { pinned_message_id: null })
  expect(await h.api<Message[]>('GET', path + '/pins', guest.token)).toEqual([])

  const other = (await h.api<Channel[]>('GET', '/api/channels', owner.token)).find(channel => channel.type === 'board')!
  await h.api('POST', `/api/channels/${other.id}/messages`, owner.token, { content: 'Cross-channel', reply_to_id: first.id }, 404)
})

test('filters bookmarks and search by membership, updates boards, locates windows and lists attachments', async () => {
  const h = await harness()
  const owner = await h.person('owner')
  const guest = await h.person('guest', await h.invite(owner.token))
  const board = (await h.api<Channel[]>('GET', '/api/channels', owner.token)).find(room => room.type === 'board')!
  const path = '/api/channels/' + board.id
  const send = (content: string, extra = {}) => h.api<Message>('POST', path + '/messages', owner.token, { content, ...extra }, 201)
  const old = await send('Old entry')
  const first = await send('你好 Foo_bar')
  const image = { url: '/uploads/' + 'a'.repeat(32), name: 'photo.png', mime: 'image/png', size: 100 }
  const target = await send('你好 FOO_BAR', { attachments: [image] })
  const reply = await send('Thread entry', { thread_root_id: target.id })
  const latest = await send('New entry')
  expect(target.board_status).toBe('open')
  expect(reply.board_status).toBeNull()
  const messagePath = '/api/messages/' + target.id
  expect(await h.api('PATCH', messagePath, guest.token, { board_status: 'done' })).toMatchObject({ board_status: 'done' })
  await h.api('PATCH', messagePath, guest.token, { content: 'Cannot edit' }, 403)
  await h.api('PATCH', '/api/messages/' + reply.id, guest.token, { board_status: 'done' }, 400)
  const centered = await h.api<MessagePage>('GET', path + '/messages?limit=3&around=' + target.id, guest.token)
  expect(centered.messages.map(row => row.id)).toEqual([latest.id, target.id, first.id])
  expect(centered.next_before).toBe(first.id)
  expect((await h.api<MessagePage>('GET', path + '/messages?before=' + first.id, guest.token)).messages.map(row => row.id)).toEqual([old.id])
  expect((await h.api<MessagePage>('GET', path + '/messages?around=' + reply.id, guest.token)).messages.map(row => row.id)).toEqual([reply.id])
  expect(await h.api<ChannelFile[]>('GET', path + '/files', guest.token)).toEqual([expect.objectContaining({
    message_id: target.id, attachment: image, author: owner.user,
  })])
  const search = '/api/search?q=foo_bar&channel_id=' + board.id + '&author_id=' + owner.user.id + '&has_attachments='
  expect((await h.api<SearchHit[]>('GET', search + 'true', guest.token)).map(row => row.id)).toEqual([target.id])
  expect((await h.api<SearchHit[]>('GET', search + 'false', guest.token)).map(row => row.id)).toEqual([first.id])
  const hidden = await h.api<Channel>('POST', '/api/channels', owner.token, { type: 'private', name: 'Hidden' }, 201)
  await h.api('POST', `/api/channels/${hidden.id}/messages`, owner.token, { content: 'Only in private room' }, 201)
  expect(await h.api('GET', '/api/search?q=Only+in+private', guest.token)).toEqual([])
  await h.api('POST', '/api/bookmarks', guest.token, { message_id: target.id, note: 'Review' })
  await h.api('POST', '/api/bookmarks', guest.token, { message_id: target.id, note: 'Reviewed' })
  expect(await h.api<Bookmark[]>('GET', '/api/bookmarks', guest.token)).toEqual([expect.objectContaining({
    note: 'Reviewed', message: expect.objectContaining({ id: target.id }),
  })])
  expect(await h.api('GET', '/api/bookmarks', owner.token)).toEqual([])
  await h.api('POST', path + '/leave', guest.token)
  expect(await h.api('GET', '/api/bookmarks', guest.token)).toEqual([])
  await h.api('DELETE', '/api/bookmarks/' + target.id, guest.token)
})
