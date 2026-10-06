export default defineEventHandler((event) => {
  const { group, id, expiresIn, download } = getQuery(event) as Record<string, string>
  return useFileStorage().signedUrl({ group: group!, id: id! }, { expiresIn: Number(expiresIn ?? 3600), download: download === '1' })
})
