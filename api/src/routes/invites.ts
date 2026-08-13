import { Router, Request, Response } from 'express';
import type { Router as RouterType } from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/client.js';
import { ERROR_CODES, HTTP_STATUS, SESSION_TIMEOUT_MS } from '@ship/shared';
import { logAuditEvent } from '../services/audit.js';
import { linkUserToWorkspaceViaInvite } from '../services/invite-acceptance.js';

const router: RouterType = Router();

/**
 * The user id of the caller's active session, or null if unauthenticated.
 * These invite routes are mounted WITHOUT authMiddleware (a brand-new user has
 * no account yet), so identity is read straight from the session cookie.
 */
async function currentUserId(req: Request): Promise<string | null> {
  const sessionId = req.cookies?.session_id;
  if (!sessionId) return null;
  const { rows } = await pool.query<{ user_id: string }>(
    'SELECT user_id FROM sessions WHERE id = $1 AND expires_at > NOW()',
    [sessionId]
  );
  return rows[0]?.user_id ?? null;
}

// GET /api/invites/:token - Validate invite token
router.get('/:token', async (req: Request, res: Response): Promise<void> => {
  const { token } = req.params;

  try {
    const result = await pool.query(
      `SELECT wi.id, wi.email, wi.role, wi.expires_at, wi.used_at,
              w.id as workspace_id, w.name as workspace_name,
              u.name as invited_by_name
       FROM workspace_invites wi
       JOIN workspaces w ON wi.workspace_id = w.id
       JOIN users u ON wi.invited_by_user_id = u.id
       WHERE wi.token = $1`,
      [token]
    );

    const invite = result.rows[0];

    if (!invite) {
      res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: {
          code: ERROR_CODES.NOT_FOUND,
          message: 'Invalid invite link',
        },
      });
      return;
    }

    if (invite.used_at) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: {
          code: ERROR_CODES.VALIDATION_ERROR,
          message: 'This invite has already been used',
        },
      });
      return;
    }

    if (new Date(invite.expires_at) < new Date()) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: {
          code: ERROR_CODES.VALIDATION_ERROR,
          message: 'This invite has expired',
        },
      });
      return;
    }

    // Check if user already exists
    const existingUserResult = await pool.query(
      'SELECT id FROM users WHERE LOWER(email) = LOWER($1)',
      [invite.email]
    );
    const existingUser = existingUserResult.rows[0];
    const userExists = !!existingUser;

    // Check if user is already a member of this workspace
    let alreadyMember = false;
    if (existingUser) {
      const membershipResult = await pool.query(
        'SELECT id FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2',
        [invite.workspace_id, existingUser.id]
      );
      alreadyMember = !!membershipResult.rows[0];

      if (alreadyMember) {
        // Mark invite as used since user is already a member
        await pool.query(
          'UPDATE workspace_invites SET used_at = NOW() WHERE id = $1',
          [invite.id]
        );
      }
    }

    res.json({
      success: true,
      data: {
        id: invite.id,
        email: invite.email,
        role: invite.role,
        workspaceId: invite.workspace_id,
        workspaceName: invite.workspace_name,
        invitedBy: invite.invited_by_name,
        expiresAt: invite.expires_at,
        userExists,
        alreadyMember,
      },
    });
  } catch (error) {
    console.error('Validate invite error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: {
        code: ERROR_CODES.INTERNAL_ERROR,
        message: 'Failed to validate invite',
      },
    });
  }
});

// POST /api/invites/:token/accept - Accept invite and create account
router.post('/:token/accept', async (req: Request, res: Response): Promise<void> => {
  const { token } = req.params;
  const { password, name } = req.body;

  try {
    // Get invite details
    const inviteResult = await pool.query(
      `SELECT wi.id, wi.email, wi.role, wi.expires_at, wi.used_at, wi.workspace_id,
              w.name as workspace_name
       FROM workspace_invites wi
       JOIN workspaces w ON wi.workspace_id = w.id
       WHERE wi.token = $1`,
      [token]
    );

    const invite = inviteResult.rows[0];

    if (!invite) {
      res.status(HTTP_STATUS.NOT_FOUND).json({
        success: false,
        error: {
          code: ERROR_CODES.NOT_FOUND,
          message: 'Invalid invite link',
        },
      });
      return;
    }

    if (invite.used_at) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: {
          code: ERROR_CODES.VALIDATION_ERROR,
          message: 'This invite has already been used',
        },
      });
      return;
    }

    if (new Date(invite.expires_at) < new Date()) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: {
          code: ERROR_CODES.VALIDATION_ERROR,
          message: 'This invite has expired',
        },
      });
      return;
    }

    // Check if user already exists (case-insensitive email match)
    const existingUserResult = await pool.query(
      'SELECT id, name FROM users WHERE LOWER(email) = LOWER($1)',
      [invite.email]
    );
    let user = existingUserResult.rows[0];

    if (user) {
      // User exists - check if already member of workspace
      const existingMemberResult = await pool.query(
        'SELECT id FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2',
        [invite.workspace_id, user.id]
      );

      if (existingMemberResult.rows[0]) {
        // User is already a member - mark invite as used to clean it up
        await pool.query(
          'UPDATE workspace_invites SET used_at = NOW() WHERE id = $1',
          [invite.id]
        );

        res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          error: {
            code: ERROR_CODES.VALIDATION_ERROR,
            message: 'You are already a member of this workspace. Please log in instead.',
          },
        });
        return;
      }

      // Existing account, not yet a member of this workspace. A pending invite
      // token must NOT by itself authenticate an existing user — that would be
      // account takeover (CWE-287): anyone holding the token would get a session
      // as the invited person. Require the caller to ALREADY hold a session for
      // THIS user before joining them, and never mint a new session here.
      const callerId = await currentUserId(req);
      if (callerId !== user.id) {
        res.status(HTTP_STATUS.UNAUTHORIZED).json({
          success: false,
          error: {
            code: ERROR_CODES.UNAUTHORIZED,
            message:
              'This email already has a Ship account. Log in as that account first, then reopen this invite link to join the workspace.',
          },
          data: { requiresLogin: true, email: invite.email },
        });
        return;
      }

      // The caller IS the invited user (proven by their own session). Add the
      // membership via the shared service (which also marks the invite used) and
      // return — they are already authenticated, so no new session is issued.
      await linkUserToWorkspaceViaInvite(user, invite);
      await logAuditEvent({
        workspaceId: invite.workspace_id,
        actorUserId: user.id,
        action: 'invite.accept',
        resourceType: 'invite',
        resourceId: invite.id,
        details: { email: invite.email, role: invite.role, existing_user: true },
        req,
      });
      res.status(HTTP_STATUS.OK).json({
        success: true,
        data: { workspace_id: invite.workspace_id, joined: true },
      });
      return;
    } else {
      // Create new user
      if (!password || password.length < 8) {
        res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          error: {
            code: ERROR_CODES.VALIDATION_ERROR,
            message: 'Password must be at least 8 characters',
          },
        });
        return;
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const userName = name || invite.email.split('@')[0];

      const newUserResult = await pool.query(
        `INSERT INTO users (email, password_hash, name, last_workspace_id)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name`,
        [invite.email, passwordHash, userName, invite.workspace_id]
      );

      user = newUserResult.rows[0];
    }

    // Use shared service for membership + person doc + invite marking
    await linkUserToWorkspaceViaInvite(user, invite);

    // Create session
    const sessionId = uuidv4();
    const expiresAt = new Date(Date.now() + SESSION_TIMEOUT_MS);

    await pool.query(
      `INSERT INTO sessions (id, user_id, workspace_id, expires_at, last_activity)
       VALUES ($1, $2, $3, $4, $5)`,
      [sessionId, user.id, invite.workspace_id, expiresAt, new Date()]
    );

    await logAuditEvent({
      workspaceId: invite.workspace_id,
      actorUserId: user.id,
      action: 'invite.accept',
      resourceType: 'invite',
      resourceId: invite.id,
      details: { email: invite.email, role: invite.role },
      req,
    });

    // Set cookie
    res.cookie('session_id', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: SESSION_TIMEOUT_MS,
    });

    res.status(HTTP_STATUS.CREATED).json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: invite.email,
          name: user.name,
        },
        workspace: {
          id: invite.workspace_id,
          name: invite.workspace_name,
          role: invite.role,
        },
      },
    });
  } catch (error) {
    console.error('Accept invite error:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: {
        code: ERROR_CODES.INTERNAL_ERROR,
        message: 'Failed to accept invite',
      },
    });
  }
});

export default router;
