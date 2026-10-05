export default defineEventHandler(async (event) => {
  const file = await readUploadedFile(event)
  const thumb = await generateThumbnail(file.data, file.type, { width: 120, height: 120 })
  return thumb && { mime: thumb.mime, width: thumb.width, height: thumb.height }
})
