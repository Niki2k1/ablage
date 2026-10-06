// Not `.get.ts`: Nitro registers those for GET only, and HEAD would fall through to the page renderer.
export default defineEventHandler((event) => {
  const { group, id, disposition } = getQuery(event) as Record<string, string>
  return sendStoredFile(event, { group: group!, id: id! }, {
    disposition: disposition as 'inline' | 'attachment' | undefined,
  })
})
