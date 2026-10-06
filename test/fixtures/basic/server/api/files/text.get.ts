export default defineEventHandler(async (event) => {
  const { group, id } = getQuery(event) as { group: string, id: string }
  const file = await useFileStorage().get({ group, id })
  if (!file) throw createError({ statusCode: 404 })
  const { body: _body, bytes, ...object } = file
  return { ...object, text: new TextDecoder().decode(await bytes()) }
})
