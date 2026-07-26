import type { APIRequestContext } from '@playwright/test'

export interface TestAccount {
  username: string
  displayName: string
  password: string
}

export async function firstJoinedGuildID(request: APIRequestContext) {
  const response = await request.get('/api/bootstrap')
  if (!response.ok()) throw new Error(`bootstrap failed: ${response.status()}`)
  const payload = await response.json() as { guilds: Array<{ id: number; joined: boolean }> }
  const guild = payload.guilds.find((item) => item.joined)
  if (!guild) throw new Error('test account has no joined guild')
  return guild.id
}

export async function createGuildMember(request: APIRequestContext, guildID: number, account: TestAccount) {
  const createResponse = await request.post('/api/platform/users', { data: { ...account, role: 'member' } })
  if (!createResponse.ok()) throw new Error(`create platform user failed: ${createResponse.status()}`)
  const user = (await createResponse.json() as { user: { id: number } }).user
  const memberResponse = await request.post(`/api/guilds/${guildID}/members`, { data: { username: account.username } })
  if (!memberResponse.ok()) throw new Error(`add guild member failed: ${memberResponse.status()}`)
  return user
}

export async function deletePlatformUser(request: APIRequestContext, userID: number, username: string) {
  return request.delete(`/api/platform/users/${userID}`, { data: { username } })
}
