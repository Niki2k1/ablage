export default defineEventHandler(async (event) => {
  const file = await readUploadedFile(event, { types: ['image', '.stl'], maxSize: '1KB' })
  return useFileStorage().put(file.fields.group ?? 'validated', file.data, { name: file.name, contentType: file.type })
})
