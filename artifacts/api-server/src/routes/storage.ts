import { Readable } from "node:stream";
import {
  ClaimUploadedObjectBody,
  ClaimUploadedObjectResponse,
  RequestUploadUrlBody,
  RequestUploadUrlResponse,
} from "@workspace/api-zod";
import { Router, type IRouter, type Request, type Response } from "express";
import { ObjectPermission } from "../lib/objectAcl";
import {
  ObjectNotFoundError,
  ObjectStorageService,
} from "../lib/objectStorage";

const router: IRouter = Router();
const storage = new ObjectStorageService();
const MAX_PANEL_BYTES = 100 * 1024 * 1024;
const ACCEPTED_PANEL_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function streamResponse(response: globalThis.Response, res: Response): void {
  res.status(response.status);
  response.headers.forEach((value, key) => res.setHeader(key, value));
  if (response.body) {
    Readable.fromWeb(response.body as ReadableStream<Uint8Array>).pipe(res);
  } else {
    res.end();
  }
}

router.post(
  "/storage/uploads/request-url",
  async (req: Request, res: Response): Promise<void> => {
    if (!req.isAuthenticated()) {
      res.status(401).json({ error: "Sign in required" });
      return;
    }
    const parsed = RequestUploadUrlBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    if (
      parsed.data.size > MAX_PANEL_BYTES ||
      !ACCEPTED_PANEL_TYPES.has(parsed.data.contentType)
    ) {
      res.status(400).json({
        error: "Upload a JPG, PNG, or WebP image smaller than 100 MB.",
      });
      return;
    }

    try {
      const uploadURL = await storage.getObjectEntityUploadURL();
      const objectPath = storage.normalizeObjectEntityPath(uploadURL);
      res.json(
        RequestUploadUrlResponse.parse({
          uploadURL,
          objectPath,
          metadata: parsed.data,
        }),
      );
    } catch (error) {
      req.log.error({ err: error }, "Could not create panel upload URL");
      res.status(500).json({ error: "Could not prepare the panel upload." });
    }
  },
);

router.post(
  "/storage/objects/claim",
  async (req: Request, res: Response): Promise<void> => {
    if (!req.isAuthenticated()) {
      res.status(401).json({ error: "Sign in required" });
      return;
    }
    const parsed = ClaimUploadedObjectBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    if (!/^\/objects\/uploads\/[a-f0-9-]{36}$/i.test(parsed.data.objectPath)) {
      res.status(400).json({ error: "Invalid uploaded panel path." });
      return;
    }
    try {
      const objectPath = await storage.trySetObjectEntityAclPolicy(
        parsed.data.objectPath,
        { owner: req.user.id, visibility: "private" },
      );
      res.json(ClaimUploadedObjectResponse.parse({ objectPath }));
    } catch (error) {
      req.log.warn({ err: error }, "Could not claim uploaded panel");
      res.status(400).json({ error: "The uploaded panel could not be found." });
    }
  },
);

router.get(
  "/storage/public-objects/*filePath",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const raw = req.params.filePath;
      const filePath = Array.isArray(raw) ? raw.join("/") : raw;
      const file = await storage.searchPublicObject(filePath);
      if (!file) {
        res.status(404).json({ error: "File not found" });
        return;
      }
      streamResponse(await storage.downloadObject(file), res);
    } catch (error) {
      req.log.error({ err: error }, "Could not serve public object");
      res.status(500).json({ error: "Could not serve the requested file." });
    }
  },
);

router.get(
  "/storage/objects/*path",
  async (req: Request, res: Response): Promise<void> => {
    if (!req.isAuthenticated()) {
      res.status(401).json({ error: "Sign in required" });
      return;
    }
    try {
      const raw = req.params.path;
      const wildcardPath = Array.isArray(raw) ? raw.join("/") : raw;
      const objectFile = await storage.getObjectEntityFile(
        `/objects/${wildcardPath}`,
      );
      const canRead = await storage.canAccessObjectEntity({
        userId: req.user.id,
        objectFile,
        requestedPermission: ObjectPermission.READ,
      });
      if (!canRead) {
        res.status(403).json({ error: "You do not have access to this panel." });
        return;
      }
      streamResponse(await storage.downloadObject(objectFile, 60), res);
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        res.status(404).json({ error: "Panel not found" });
        return;
      }
      req.log.error({ err: error }, "Could not serve a private panel");
      res.status(500).json({ error: "Could not serve the requested panel." });
    }
  },
);

export default router;
