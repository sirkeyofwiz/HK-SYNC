import { API } from './api';
import { IS_NATIVE } from './push';

// Phone photos are several MB; downscale to JPEG before upload so reports stay well under the API's request size limit.
// 1280px is still sharp on any phone or laptop screen and about 40% smaller than 1600px, so big inspections fit in one report.
// HEIC / HEIF is the "high efficiency" format of iPhones and some Samsung phones. Browsers can't open it (iPhones convert
// it to JPEG when sharing to a web page, but files copied over can still be HEIC), so say what to do instead.
export const isHeic = (file) => /^image\/hei[cf]/i.test(file?.type || '') || /\.(heic|heif)$/i.test(file?.name || '');
export const HEIC_HELP = 'is a HEIC "high efficiency" photo, which the app can\'t open. Take the picture with the 📷 Camera button instead, or set the phone camera to save JPEG: on Samsung turn off Camera › Settings › "High efficiency pictures"; on iPhone choose Settings › Camera › Formats › "Most Compatible".';
// The types chat can send, by file name when the phone's file picker doesn't say (some Android pickers leave it blank).
const FILE_TYPES = { pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', txt: 'text/plain', csv: 'text/csv', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
const SENDABLE = new Set(Object.values(FILE_TYPES));
export const fileType = (file) => (SENDABLE.has(file.type) ? file.type : FILE_TYPES[String(file.name).split('.').pop().toLowerCase()] || file.type || '');
// Any other picture the phone can show (BMP, AVIF…) is fine too: it is turned into a JPEG before sending.
export const canSend = (file) => !isHeic(file) && (SENDABLE.has(fileType(file)) || file.type.startsWith('image/'));
export const compressPhoto = (file, maxSize = 1280, quality = 0.7) => new Promise((resolve, reject) => { const url = URL.createObjectURL(file); const image = new Image(); image.onload = () => { const scale = Math.min(1, maxSize / Math.max(image.width, image.height)); const canvas = document.createElement('canvas'); canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale); canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height); URL.revokeObjectURL(url); resolve(canvas.toDataURL('image/jpeg', quality)); }; image.onerror = () => { URL.revokeObjectURL(url); reject(new Error(isHeic(file) ? `"${file.name}" ${HEIC_HELP}` : `Could not open "${file.name}" as a photo. Try taking it again with the 📷 Camera button.`)); }; image.src = url; });
export const fileSize = (bytes) => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
// Attachments need the login token, so they're fetched once and shown from a local object URL.
export const attachmentUrls = new Map();
// Each downloaded attachment is kept as a Blob plus an object URL for <img>/<audio>/links. "Open" needs the Blob itself:
// the content security policy (rightly) doesn't let the app fetch() its own blob: URLs.
export const attachmentBlobs = new Map();
export const fetchAttachment = async (id) => { if (attachmentUrls.has(id)) return attachmentUrls.get(id); const res = await fetch(`${API}/attachments/${id}`, { headers: { Authorization: `Bearer ${localStorage.getItem('bahari-token')}` } }); if (!res.ok) throw new Error('This attachment is no longer available.'); const blob = await res.blob(); const url = URL.createObjectURL(blob); attachmentBlobs.set(id, blob); attachmentUrls.set(id, url); return url; };
// Clipboard API first; the old selection method covers browsers or contexts where it is blocked.
export const copyText = async (text) => { try { await navigator.clipboard.writeText(text); return true; } catch { const area = document.createElement('textarea'); area.value = text; area.setAttribute('readonly', ''); area.style.position = 'fixed'; area.style.opacity = '0'; document.body.append(area); area.select(); const ok = document.execCommand('copy'); area.remove(); return ok; } };
// Inside the Android app the WebView can't download files and has no web share menu, so files go through native plugins:
// "Save" writes to Documents › HK-SYNC, "Open" hands the file to a viewer app, "Share" opens Android's share menu.
export const SAVED_FOLDER = 'Documents › HK-SYNC';
export const blobBase64 = (blob) => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); });
export const writeNativeFile = async (blob, name, directory) => {
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const clean = name.replace(/[\\/:*?"<>|]+/g, '_');
  const data = await blobBase64(blob);
  const write = (fileName) => Filesystem.writeFile({ path: `HK-SYNC/${fileName}`, data, directory: Directory[directory], recursive: true });
  // Android 11+ won't let the app overwrite a file in Documents left by an earlier install, so retry under a new name.
  try { return (await write(clean)).uri; } catch (error) { if (directory !== 'Documents') throw error; const dot = clean.lastIndexOf('.'); const stamp = `-${Date.now().toString(36)}`; return (await write(dot > 0 ? clean.slice(0, dot) + stamp + clean.slice(dot) : clean + stamp)).uri; }
};
export const shareNativeFile = async (blob, name) => { const { Share } = await import('@capacitor/share'); try { await Share.share({ files: [await writeNativeFile(blob, name, 'Cache')], title: name, dialogTitle: name }); } catch (error) { if (!/cancel/i.test(error?.message || '')) throw error; } };
// Opens in a viewer app (PDF reader, WPS, Excel, Gallery…); with no app for that type, the share menu still lets them send it on.
export const openNativeFile = async (blob, name, mimeType, uri) => { const { FileOpener } = await import('@capawesome-team/capacitor-file-opener'); const path = uri || await writeNativeFile(blob, name, 'Cache'); try { await FileOpener.openFile({ path, mimeType: mimeType || blob.type || undefined }); } catch { await shareNativeFile(blob, name); } };
// Web: a normal download. App: saved to Documents › HK-SYNC; returns the saved file's address, or null on the web.
export const saveFile = async (blob, name) => { if (IS_NATIVE) return writeNativeFile(blob, name, 'Documents'); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 5000); return null; };
export const attachmentBlob = async (attachment) => { await fetchAttachment(attachment.id); return attachmentBlobs.get(attachment.id); };
export const downloadAttachment = async (attachment) => saveFile(await attachmentBlob(attachment), attachment.name);
export const shareAttachment = async (attachment) => shareNativeFile(await attachmentBlob(attachment), attachment.name);
// "Open" a chat file. A web app can't open a file already saved in Downloads, so tapping the old card downloaded a new
// copy every time. Phones get their own "Open with" menu (Excel, WPS, Word, Drive, PDF viewer…) straight from the copy
// already loaded in the app; computers show PDFs and text in a new tab. Anything else falls back to a download.
export const openAttachment = async (attachment) => {
  const url = await fetchAttachment(attachment.id);
  const blob = attachmentBlobs.get(attachment.id);
  if (IS_NATIVE) return openNativeFile(blob, attachment.name, attachment.type);
  const file = new File([blob], attachment.name, { type: attachment.type || blob.type });
  // Phones and tablets only: desktop Chrome also offers sharing, but there "Open" should open, not show Windows' share window.
  const handheld = navigator.userAgentData?.mobile || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (handheld && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: attachment.name }); return; } catch (error) { if (error.name === 'AbortError') return; }
  }
  if (/^(application\/pdf|text\/plain|text\/csv)$/.test(attachment.type)) {
    const tab = window.open(url, '_blank');
    if (tab) { tab.opener = null; return; }
  }
  await downloadAttachment(attachment);
};
