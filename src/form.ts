import { api, Connection, DRIVERS, Driver, SecretsInput, SshAuth } from "./api";
import { h } from "./dom";
import { t } from "./i18n";

export interface FormResult {
  saved?: Connection;
  deletedId?: string;
}

function blank(): Connection {
  return { id: "", name: "", driver: "mysql", host: "127.0.0.1", port: 3306, username: "root", database: "", ssh: null };
}

/** Modal dialog for creating/editing a connection. */
export function openConnectionForm(existing: Connection | null): Promise<FormResult> {
  return new Promise((resolve) => {
    const conn: Connection = structuredClone(existing ?? blank());
    const saved = conn.saved ?? { dbPassword: false, sshPassword: false, keyPassphrase: false };
    // secrets: undefined = keep the stored value, "" = delete it
    const secrets: SecretsInput = {};

    const field = (label: string, input: HTMLElement, hint?: string) =>
      h("label", { class: "field" }, h("span", {}, label), input, hint ? h("small", {}, hint) : null);

    const text = (value: string, oninput: (v: string) => void, attrs: Record<string, unknown> = {}) =>
      h("input", { type: "text", value, spellcheck: false, autocomplete: "off", oninput: (e: Event) => oninput((e.target as HTMLInputElement).value), ...attrs });

    const number = (value: number, oninput: (v: number) => void) =>
      h("input", { type: "number", min: 1, max: 65535, value: String(value || ""), oninput: (e: Event) => oninput(Number((e.target as HTMLInputElement).value) || 0) });

    /** Secret field: empty + "saved" = unchanged; the "forget" button deletes it. */
    const secret = (key: keyof SecretsInput, isSaved: boolean) => {
      const forgotten = isSaved && secrets[key] === "";
      const input = h("input", {
        type: "password",
        autocomplete: "new-password",
        value: secrets[key] ?? "",
        placeholder: forgotten ? t("form.willDelete") : isSaved ? t("form.saved") : "",
        oninput: (e: Event) => {
          const v = (e.target as HTMLInputElement).value;
          secrets[key] = v === "" && isSaved ? undefined : v;
        },
      });
      const show = h("button", { type: "button", class: "ghost icon", title: t("form.show"), onclick: () => (input.type = input.type === "password" ? "text" : "password") }, "👁");
      const forget = isSaved && !forgotten
        ? h("button", { type: "button", class: "ghost small", title: t("form.forgetTitle"), onclick: () => {
            secrets[key] = "";
            input.value = "";
            input.placeholder = t("form.willDelete");
            forget!.remove();
          } }, t("form.forget"))
        : null;
      return h("div", { class: "secret" }, input, show, forget);
    };

    /** Text input + "Browse…" button opening the native file picker. */
    const fileInput = (kind: "sshKey" | "sqlite", value: string, set: (v: string) => void, placeholder: string) => {
      const input = text(value, set, { placeholder });
      const browse = h("button", { type: "button", class: "ghost", onclick: async () => {
        const picked = await api.pickFile(kind, input.value).catch(() => null);
        if (picked) {
          input.value = picked;
          set(picked);
        }
      } }, t("form.browse"));
      return h("div", { class: "with-button" }, input, browse);
    };

    const body = h("div", { class: "form-body" });
    const status = h("div", { class: "form-status" });

    const render = () => {
      body.replaceChildren();
      const isSqlite = conn.driver === "sqlite";

      const driver = h("select", {
        onchange: (e: Event) => {
          const prev = conn.driver;
          conn.driver = (e.target as HTMLSelectElement).value as Driver;
          if (!conn.port || conn.port === DRIVERS[prev].port) conn.port = DRIVERS[conn.driver].port;
          if (conn.driver === "sqlite") {
            conn.ssh = null;
            if (conn.host === "127.0.0.1") conn.host = "";
          } else if (!conn.host) conn.host = "127.0.0.1";
          if (conn.driver === "pgsql" && conn.username === "root") conn.username = "postgres";
          if (conn.driver === "mysql" && conn.username === "postgres") conn.username = "root";
          render();
        },
      }, ...Object.entries(DRIVERS).map(([k, d]) => h("option", { value: k, selected: k === conn.driver }, d.label)));

      body.append(
        h("div", { class: "row" },
          field(t("form.name"), text(conn.name, (v) => (conn.name = v), { placeholder: "prod-db", autofocus: true })),
          field(t("form.driver"), driver),
        ),
      );

      if (isSqlite) {
        body.append(field(t("form.file"), fileInput("sqlite", conn.host, (v) => (conn.host = v), "/path/to/db.sqlite"), t("form.fileHint")));
      } else {
        body.append(
          h("div", { class: "row" },
            field(conn.ssh ? t("form.hostSsh") : t("form.host"), text(conn.host, (v) => (conn.host = v), { placeholder: "127.0.0.1" })),
            h("div", { class: "narrow" }, field(t("form.port"), number(conn.port, (v) => (conn.port = v)))),
          ),
          h("div", { class: "row" },
            field(t("form.user"), text(conn.username, (v) => (conn.username = v))),
            field(t("form.password"), secret("dbPassword", saved.dbPassword)),
          ),
          field(t("form.database"), text(conn.database, (v) => (conn.database = v), { placeholder: t("form.optional") })),
          h("label", { class: "check" },
            h("input", { type: "checkbox", checked: !!conn.ssh, onchange: (e: Event) => {
              conn.ssh = (e.target as HTMLInputElement).checked
                ? (existing?.ssh ? structuredClone(existing.ssh) : { host: "", port: 22, username: "", auth: "password", keyPath: "" })
                : null;
              render();
            } }),
            " " + t("form.useSsh"),
          ),
        );

        if (conn.ssh) {
          const ssh = conn.ssh;
          const authRadio = (value: SshAuth, label: string) =>
            h("label", { class: "radio" },
              h("input", { type: "radio", name: "ssh-auth", value, checked: ssh.auth === value, onchange: () => { ssh.auth = value; render(); } }),
              " " + label,
            );
          body.append(
            h("fieldset", { class: "ssh" },
              h("legend", {}, "SSH"),
              h("div", { class: "row" },
                field(t("form.sshHost"), text(ssh.host, (v) => (ssh.host = v), { placeholder: "server.example.com" })),
                h("div", { class: "narrow" }, field(t("form.port"), number(ssh.port, (v) => (ssh.port = v)))),
              ),
              field(t("form.sshUser"), text(ssh.username, (v) => (ssh.username = v), { placeholder: "deploy" })),
              h("div", { class: "radios" }, authRadio("password", t("form.authPassword")), authRadio("key", t("form.authKey"))),
              ssh.auth === "password"
                ? field(t("form.sshPassword"), secret("sshPassword", saved.sshPassword))
                : h("div", {},
                    field(t("form.keyFile"), fileInput("sshKey", ssh.keyPath, (v) => (ssh.keyPath = v), t("form.keyFilePh"))),
                    field(t("form.passphrase"), secret("keyPassphrase", saved.keyPassphrase), t("form.passphraseHint")),
                  ),
              existing?.ssh
                ? h("button", { type: "button", class: "ghost small", onclick: async () => {
                    await api.forgetHostKey(conn);
                    setStatus("ok", t("form.hostKeyReset"));
                  } }, t("form.resetHostKey"))
                : null,
            ),
          );
        }
      }
      body.querySelector<HTMLInputElement>("[autofocus]")?.focus();
    };

    const setStatus = (kind: "ok" | "err" | "busy" | "", msg = "") => {
      status.className = `form-status ${kind}`;
      status.textContent = msg;
    };

    const close = (result: FormResult) => {
      dialog.close();
      dialog.remove();
      resolve(result);
    };

    const testBtn = h("button", { type: "button", class: "ghost", onclick: async () => {
      setStatus("busy", t("form.testing"));
      testBtn.disabled = true;
      try {
        setStatus("ok", "✓ " + (await api.test(conn, secrets)));
      } catch (e) {
        setStatus("err", String(e));
      } finally {
        testBtn.disabled = false;
      }
    } }, t("form.test"));

    const form = h("form", { method: "dialog", onsubmit: async (e: Event) => {
      e.preventDefault();
      try {
        close({ saved: await api.save(conn, secrets) });
      } catch (err) {
        setStatus("err", String(err));
      }
    } },
      h("header", {}, h("h2", {}, existing ? t("form.titleEdit") : t("form.titleNew"))),
      body,
      status,
      h("footer", {},
        existing
          ? h("button", { type: "button", class: "danger ghost", onclick: async () => {
              if (!confirm(t("form.confirmDelete", { name: existing.name }))) return;
              await api.remove(existing.id);
              close({ deletedId: existing.id });
            } }, t("form.delete"))
          : null,
        h("span", { class: "spacer" }),
        testBtn,
        h("button", { type: "button", class: "ghost", onclick: () => close({}) }, t("form.cancel")),
        h("button", { type: "submit", class: "primary" }, t("form.save")),
      ),
    );

    const dialog = h("dialog", { class: "modal", oncancel: (e: Event) => { e.preventDefault(); close({}); } }, form);
    document.body.append(dialog);
    render();
    dialog.showModal();
  });
}
