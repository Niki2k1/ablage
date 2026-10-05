export default defineEventHandler(async (event) => {
  const file = await readUploadedFile(event, { types: ['image', '.stl'], maxSize: '1KB' })
  const id = await useFileStorage().upload(file.fields.group ?? 'validated', file.data, {
    meta: { name: file.name, mime: file.type, type: 'upload', version: 1 },
  })
  return { id, name: file.name, type: file.type, size: file.size, group: file.fields.group }
})
