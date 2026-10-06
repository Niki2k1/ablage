export default defineEventHandler(async (event) => {
  const { group, id } = getQuery(event) as { group: string, id: string }
  return (await useFileStorage().head({ group, id })) ?? createError({ statusCode: 404 })
})
