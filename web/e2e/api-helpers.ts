import type { APIRequestContext } from '@playwright/test'

export interface TestAccount {
  username: string
  displayName: string
  password: string
}

export async function firstJoinedServerID(request: APIRequestContext) {
  const response = await request.get('/api/bootstrap')
  if (!response.ok()) throw new Error(`bootstrap failed: ${response.status()}`)
  const payload = await response.json() as { servers: Array<{ id: number; joined: boolean }> }
  const server = payload.servers.find((item) => item.joined)
  if (!server) throw new Error('test account has no joined server')
  return server.id
}

export async function createServerMember(request: APIRequestContext, serverID: number, account: TestAccount) {
  const createResponse = await request.post('/api/platform/users', { data: { ...account, role: 'member' } })
  if (!createResponse.ok()) throw new Error(`create platform user failed: ${createResponse.status()}`)
  const user = (await createResponse.json() as { user: { id: number } }).user
  const memberResponse = await request.post(`/api/servers/${serverID}/members`, { data: { username: account.username } })
  if (!memberResponse.ok()) throw new Error(`add server member failed: ${memberResponse.status()}`)
  return user
}

export async function deletePlatformUser(request: APIRequestContext, userID: number, username: string) {
  return request.delete(`/api/platform/users/${userID}`, { data: { username } })
}
