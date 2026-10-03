import { neon } from '@neondatabase/serverless';
import crypto from 'node:crypto';

const URL_DB = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.DATABASE_URL_UNPOOLED || process.env.POSTGRES_URL_NON_POOLING;
const sql = neon(URL_DB || 'postgresql://x:x@localhost/x');
const SECRET = process.env.AUTH_SECRET || 'troque-esta-chave';
let ready;
const init = () => (ready ||= (async () => {
  await sql`CREATE TABLE IF NOT EXISTS comup_users(id SERIAL PRIMARY KEY, nome TEXT NOT NULL, telefone TEXT, paroquia TEXT, diocese TEXT, cargo TEXT, email TEXT UNIQUE NOT NULL, senha TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now())`;
  await sql`CREATE TABLE IF NOT EXISTS comup_plans(id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES comup_users(id) ON DELETE CASCADE, titulo TEXT NOT NULL, assunto TEXT, tipo TEXT DEFAULT 'planejamento', importancia TEXT DEFAULT 'media', status TEXT DEFAULT 'pendente', data_hora TIMESTAMPTZ, descricao TEXT, pdf_nome TEXT, pdf_data TEXT, created_at TIMESTAMPTZ DEFAULT now())`;
  await sql`ALTER TABLE comup_plans ADD COLUMN IF NOT EXISTS responsavel TEXT`;
  await sql`ALTER TABLE comup_plans ADD COLUMN IF NOT EXISTS canal TEXT`;
  await sql`CREATE TABLE IF NOT EXISTS comup_teams(id SERIAL PRIMARY KEY, nome TEXT NOT NULL, codigo TEXT UNIQUE NOT NULL, created_at TIMESTAMPTZ DEFAULT now())`;
  await sql`ALTER TABLE comup_users ADD COLUMN IF NOT EXISTS team_id INT REFERENCES comup_teams(id) ON DELETE SET NULL`;
  await sql`ALTER TABLE comup_users ADD COLUMN IF NOT EXISTS papel TEXT`;
  await sql`ALTER TABLE comup_plans ADD COLUMN IF NOT EXISTS visib TEXT DEFAULT 'equipe'`;
  await sql`ALTER TABLE comup_plans ADD COLUMN IF NOT EXISTS concluido_em TIMESTAMPTZ`;
  await sql`UPDATE comup_plans SET concluido_em=created_at WHERE status='concluido' AND concluido_em IS NULL`;
})().catch(e => { ready = null; throw e; }));

const hash = p => { const s = crypto.randomBytes(16).toString('hex'); return s + ':' + crypto.scryptSync(p, s, 32).toString('hex'); };
const check = (p, h) => { const [s, k] = h.split(':'); return crypto.timingSafeEqual(Buffer.from(k, 'hex'), crypto.scryptSync(p, s, 32)); };
const mac = d => crypto.createHmac('sha256', SECRET).update(d).digest('base64url');
const sign = id => { const d = Buffer.from(JSON.stringify({ id, exp: Date.now() + 30 * 864e5 })).toString('base64url'); return d + '.' + mac(d); };
const verify = t => {
  const [d, s] = (t || '').split('.'); if (!d || !s) return null;
  const e = mac(d); if (s.length !== e.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(e))) return null;
  const p = JSON.parse(Buffer.from(d, 'base64url')); return p.exp > Date.now() ? p.id : null;
};
const pub = u => ({ id: u.id, nome: u.nome, telefone: u.telefone, paroquia: u.paroquia, diocese: u.diocese, cargo: u.cargo, email: u.email, team_id: u.team_id, papel: u.papel });
class E extends Error { constructor(m, c = 400) { super(m); this.c = c; } }

export default async function handler(req, res) {
  try {
    if ((req.query.r || '') === 'saude') {
      if (!URL_DB) return res.json({ ok: false, erro: 'Variável DATABASE_URL ausente na Vercel' });
      try { await init(); const [r] = await sql`SELECT count(*)::int AS usuarios FROM comup_users`; return res.json({ ok: true, ...r }); }
      catch (e) { return res.json({ ok: false, erro: String(e.message).slice(0, 300) }); }
    }
    if (!URL_DB) throw new E('Banco de dados não configurado: falta a variável DATABASE_URL na Vercel', 500);
    await init();
    const [a, b, c] = (req.query.r || '').split('/').filter(Boolean);
    const m = req.method, d = req.body || {};
    const ok = (x, s = 200) => res.status(s).json(x);

    if (a === 'auth' && b === 'register') {
      for (const k of ['nome', 'telefone', 'paroquia', 'diocese', 'cargo', 'email', 'senha']) if (!String(d[k] || '').trim()) throw new E('Preencha todos os campos');
      if (d.senha.length < 6) throw new E('A senha deve ter ao menos 6 caracteres');
      const email = d.email.trim().toLowerCase();
      const [x] = await sql`SELECT id FROM comup_users WHERE email=${email}`;
      if (x) throw new E('Este e-mail já está cadastrado', 409);
      const [u] = await sql`INSERT INTO comup_users(nome,telefone,paroquia,diocese,cargo,email,senha) VALUES(${d.nome.trim()},${d.telefone.trim()},${d.paroquia.trim()},${d.diocese.trim()},${d.cargo.trim()},${email},${hash(d.senha)}) RETURNING *`;
      return ok({ token: sign(u.id), user: pub(u) }, 201);
    }
    if (a === 'auth' && b === 'login') {
      const [u] = await sql`SELECT * FROM comup_users WHERE email=${String(d.email || '').trim().toLowerCase()}`;
      if (!u || !check(String(d.senha || ''), u.senha)) throw new E('E-mail ou senha incorretos', 401);
      return ok({ token: sign(u.id), user: pub(u) });
    }

    if (a === 'team' && b === 'convite' && c) {
      const [t] = await sql`SELECT nome FROM comup_teams WHERE codigo=${c}`;
      if (!t) throw new E('Convite inválido ou expirado', 404);
      return ok({ nome: t.nome });
    }
    const uid = verify((req.headers.authorization || '').slice(7));
    if (!uid) throw new E('Sessão expirada. Entre novamente.', 401);

    if (a === 'me') {
      if (b === 'excluir' && m === 'POST') {
        const [u] = await sql`SELECT senha FROM comup_users WHERE id=${uid}`;
        if (!check(String(d.senha || ''), u.senha)) throw new E('Senha incorreta');
        await sql`DELETE FROM comup_users WHERE id=${uid}`;
        return ok({ ok: true });
      }
      if (b === 'password' && m === 'PUT') {
        const [u] = await sql`SELECT senha FROM comup_users WHERE id=${uid}`;
        if (!check(String(d.atual || ''), u.senha)) throw new E('Senha atual incorreta');
        if (String(d.nova || '').length < 6) throw new E('A nova senha deve ter ao menos 6 caracteres');
        await sql`UPDATE comup_users SET senha=${hash(d.nova)} WHERE id=${uid}`;
        return ok({ ok: true });
      }
      if (m === 'PUT') {
        for (const k of ['nome', 'telefone', 'paroquia', 'diocese', 'cargo']) if (!String(d[k] || '').trim()) throw new E('Preencha todos os campos');
        const [u] = await sql`UPDATE comup_users SET nome=${d.nome.trim()},telefone=${d.telefone.trim()},paroquia=${d.paroquia.trim()},diocese=${d.diocese.trim()},cargo=${d.cargo.trim()} WHERE id=${uid} RETURNING *`;
        return ok({ user: pub(u) });
      }
      const [u] = await sql`SELECT * FROM comup_users WHERE id=${uid}`;
      return ok({ user: pub(u) });
    }

    if (a === 'plans') {
      if (m === 'GET' && !b) return ok(await sql`SELECT id,titulo,assunto,tipo,importancia,status,data_hora,descricao,responsavel,canal,visib,pdf_nome,(pdf_data IS NOT NULL) AS tem_pdf FROM comup_plans WHERE user_id=${uid} ORDER BY data_hora ASC NULLS LAST, id DESC`);
      if (m === 'GET' && c === 'pdf') {
        const [r] = await sql`SELECT pdf_nome AS nome, pdf_data AS data FROM comup_plans WHERE id=${+b} AND (user_id=${uid} OR (visib<>'privado' AND user_id IN (SELECT id FROM comup_users WHERE team_id IS NOT NULL AND team_id=(SELECT team_id FROM comup_users WHERE id=${uid}))))`;
        if (!r || !r.data) throw new E('PDF não encontrado', 404);
        return ok(r);
      }
      if (m === 'DELETE') { await sql`DELETE FROM comup_plans WHERE id=${+b} AND user_id=${uid}`; return ok({ ok: true }); }
      if (m === 'POST' || m === 'PUT') {
        const p = { titulo: String(d.titulo || '').trim(), assunto: d.assunto || '', tipo: d.tipo || 'planejamento', importancia: d.importancia || 'media', status: d.status || 'pendente', data_hora: d.data_hora || null, descricao: d.descricao || '', responsavel: d.responsavel || '', canal: d.canal || '', visib: d.visib === 'privado' ? 'privado' : 'equipe' };
        if (!p.titulo) throw new E('Informe o título');
        if ((d.pdf_data || '').length > 4e6) throw new E('PDF muito grande (máximo 3 MB)');
        if (m === 'POST') {
          await sql`INSERT INTO comup_plans(user_id,titulo,assunto,tipo,importancia,status,data_hora,descricao,responsavel,canal,visib,concluido_em,pdf_nome,pdf_data) VALUES(${uid},${p.titulo},${p.assunto},${p.tipo},${p.importancia},${p.status},${p.data_hora}::timestamptz,${p.descricao},${p.responsavel},${p.canal},${p.visib},CASE WHEN ${p.status}::text='concluido' THEN now() END,${d.pdf_nome || null},${d.pdf_data || null})`;
          return ok({ ok: true }, 201);
        }
        const hp = 'pdf_data' in d;
        await sql`UPDATE comup_plans SET titulo=${p.titulo},assunto=${p.assunto},tipo=${p.tipo},importancia=${p.importancia},status=${p.status},data_hora=${p.data_hora}::timestamptz,descricao=${p.descricao},responsavel=${p.responsavel},canal=${p.canal},visib=${p.visib},concluido_em=CASE WHEN ${p.status}::text='concluido' THEN COALESCE(concluido_em,now()) END,pdf_nome=CASE WHEN ${hp}::boolean THEN ${d.pdf_nome || null}::text ELSE pdf_nome END,pdf_data=CASE WHEN ${hp}::boolean THEN ${d.pdf_data || null}::text ELSE pdf_data END WHERE id=${+b} AND user_id=${uid}`;
        return ok({ ok: true });
      }
    }
    if (a === 'team') {
      const [eu] = await sql`SELECT team_id, papel FROM comup_users WHERE id=${uid}`;
      const tid = eu.team_id, code = () => crypto.randomBytes(6).toString('hex');
      if (m === 'GET' && !b) {
        if (!tid) return ok({ team: null });
        const [t] = await sql`SELECT id,nome,codigo FROM comup_teams WHERE id=${tid}`;
        const membros = await sql`SELECT u.id,u.nome,u.cargo,u.papel,
          count(p.id) FILTER (WHERE p.status='concluido')::int AS concluidos,
          count(p.id) FILTER (WHERE p.status='concluido' AND p.concluido_em > now() - interval '30 days')::int AS c30,
          count(p.id) FILTER (WHERE p.status<>'concluido')::int AS abertos,
          count(p.id) FILTER (WHERE p.status<>'concluido' AND p.data_hora < now())::int AS atrasados
          FROM comup_users u LEFT JOIN comup_plans p ON p.user_id=u.id
          WHERE u.team_id=${tid} GROUP BY u.id ORDER BY c30 DESC, concluidos DESC, u.nome`;
        return ok({ team: { ...t, papel: eu.papel }, membros });
      }
      if (m === 'GET' && b === 'itens') {
        if (!tid) throw new E('Você não está em uma equipe');
        return ok(await sql`SELECT p.id,p.titulo,p.assunto,p.tipo,p.importancia,p.status,p.data_hora,p.descricao,p.responsavel,p.canal,p.visib,p.pdf_nome,(p.pdf_data IS NOT NULL) AS tem_pdf,p.user_id,u.nome AS dono FROM comup_plans p JOIN comup_users u ON u.id=p.user_id WHERE u.team_id=${tid} AND (p.user_id=${uid} OR p.visib<>'privado') ORDER BY p.data_hora ASC NULLS LAST, p.id DESC`);
      }
      if (m === 'POST' && !b) {
        if (tid) throw new E('Você já faz parte de uma equipe');
        const nome = String(d.nome || '').trim(); if (!nome) throw new E('Informe o nome da equipe');
        const [t] = await sql`INSERT INTO comup_teams(nome,codigo) VALUES(${nome},${code()}) RETURNING id`;
        await sql`UPDATE comup_users SET team_id=${t.id}, papel='admin' WHERE id=${uid}`;
        return ok({ ok: true }, 201);
      }
      if (m === 'POST' && b === 'entrar') {
        if (tid) throw new E('Saia da equipe atual antes de entrar em outra');
        const [t] = await sql`SELECT id FROM comup_teams WHERE codigo=${String(d.codigo || '').trim()}`;
        if (!t) throw new E('Convite inválido ou expirado');
        await sql`UPDATE comup_users SET team_id=${t.id}, papel='membro' WHERE id=${uid}`;
        return ok({ ok: true });
      }
      if (!tid) throw new E('Você não está em uma equipe');
      if (m === 'POST' && b === 'sair') {
        await sql`UPDATE comup_users SET team_id=NULL, papel=NULL WHERE id=${uid}`;
        const rest = await sql`SELECT id,papel FROM comup_users WHERE team_id=${tid} ORDER BY id`;
        if (!rest.length) await sql`DELETE FROM comup_teams WHERE id=${tid}`;
        else if (!rest.some(x => x.papel === 'admin')) await sql`UPDATE comup_users SET papel='admin' WHERE id=${rest[0].id}`;
        return ok({ ok: true });
      }
      if (eu.papel !== 'admin') throw new E('Apenas administradores podem fazer isso', 403);
      if (m === 'PUT' && !b) {
        const nome = String(d.nome || '').trim(); if (!nome) throw new E('Informe o nome da equipe');
        await sql`UPDATE comup_teams SET nome=${nome} WHERE id=${tid}`; return ok({ ok: true });
      }
      if (m === 'POST' && b === 'novolink') { await sql`UPDATE comup_teams SET codigo=${code()} WHERE id=${tid}`; return ok({ ok: true }); }
      if (m === 'POST' && b === 'admin') { await sql`UPDATE comup_users SET papel='admin' WHERE id=${+d.id} AND team_id=${tid}`; return ok({ ok: true }); }
      if (m === 'POST' && b === 'remover') {
        if (+d.id === uid) throw new E('Para sair, use "Sair da equipe"');
        await sql`UPDATE comup_users SET team_id=NULL, papel=NULL WHERE id=${+d.id} AND team_id=${tid}`;
        return ok({ ok: true });
      }
    }
    throw new E('Rota não encontrada', 404);
  } catch (e) {
    console.error(e);
    res.status(e.c || 500).json({ erro: e.c ? e.message : 'Erro interno do servidor' });
  }
}
