export default defineEventHandler((event) => {
  const { group } = getQuery(event) as { group: string }
  return useFileStorage().list(group)
})
