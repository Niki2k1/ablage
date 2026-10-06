export default defineEventHandler((event) => {
  const { group, limit, cursor, prefix } = getQuery(event) as Record<string, string | undefined>
  return useFileStorage().list(group!, { limit: limit ? Number(limit) : undefined, cursor, prefix })
})
