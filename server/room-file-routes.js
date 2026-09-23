import express from 'express';
import {httpError} from './config.js';
import {chunkSize} from './uploads.js';

export function roomFileRoutes(app, {files, membership, reauthorize, identifyDirect, directUrl, config, limit}) {
  const member = (req, roomId) => {
    req.auth = reauthorize(req);
    return membership(req, roomId);
  };
  const access = (req, writing = false) => {
    const file = files.get(req.params.fileId);
    member(req, file.roomId);
    if (writing && file.userId !== req.auth.user.id) throw httpError(403, 'Only the uploader can send file contents.');
    return file;
  };
  const status = (file, auth) => ({...files.publicFile(file), chunkSize,
    ...(config.bareMetalOrigin ? {transferUrl: directUrl(`/direct/files/${file.id}`, auth, `file-upload:${file.id}`)} : {})});
  const localOnly = (req, _res, next) => next(config.bareMetalOrigin || req.edge
    ? httpError(409, 'Use the direct file transfer URL.') : undefined);

  app.get('/api/rooms/:id/files', (req, res) => {
    member(req, req.params.id);
    res.json({files: files.snapshot(req.params.id).files, maxFileBytes: config.maxUploadBytes});
  });
  app.post('/api/rooms/:id/files', async (req, res) => {
    limit(`shared-files:${req.auth.user.id}`, 100);
    const room = member(req, req.params.id);
    const file = await files.create(room, req.auth.user, req.body, () => member(req, room.id));
    res.status(201).json({file});
  });
  app.get('/api/files/:fileId', (req, res) => res.json(status(access(req, true), req.auth)));
  const append = async (req, res) => {
    const file = access(req, true);
    const offset = typeof req.query.offset === 'string' && /^\d+$/.test(req.query.offset) ? Number(req.query.offset) : NaN;
    await files.append(file, offset, req.body, () => access(req, true));
    res.json(status(file, req.auth));
  };
  app.put('/api/files/:fileId', localOnly, (req, _res, next) => { access(req, true); next(); },
    express.raw({type: 'application/octet-stream', limit: chunkSize}), append);
  app.put('/direct/files/:fileId', identifyDirect(req => `file-upload:${req.params.fileId}`),
    (req, _res, next) => { access(req, true); next(); },
    express.raw({type: 'application/octet-stream', limit: chunkSize}), append);

  app.get('/api/files/:fileId/access', (req, res) => {
    const file = access(req);
    if (!file.complete) throw httpError(409, 'This file is still uploading.');
    res.json({url: config.bareMetalOrigin
      ? directUrl(`/direct/files/${file.id}/download`, req.auth, `file-download:${file.id}`)
      : `/api/files/${file.id}/download`});
  });
  const download = (req, res, next) => {
    const file = access(req);
    if (!file.complete) throw httpError(409, 'This file is still uploading.');
    res.download(file.id, file.name, {root: files.dir, dotfiles: 'deny', headers: {
      'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'",
    }}, error => { if (error) next(error); });
  };
  app.get('/api/files/:fileId/download', localOnly, download);
  app.get('/direct/files/:fileId/download', identifyDirect(req => `file-download:${req.params.fileId}`), download);
  app.delete('/api/files/:fileId', async (req, res) => {
    const file = access(req);
    const room = member(req, file.roomId);
    if (file.userId !== req.auth.user.id && room.ownerId !== req.auth.user.id && req.auth.user.role !== 'admin') {
      throw httpError(403, 'Only the uploader, room owner or an administrator can remove this file.');
    }
    await files.discard(file);
    res.json({ok: true});
  });
}
