/** Minimal Google Identity Services types — only what the sign-in sheet uses. */
declare namespace google.accounts.id {
  interface CredentialResponse {
    /** The Google ID token (a JWT) for the signed-in account. */
    credential: string;
    select_by?: string;
    clientId?: string;
  }

  interface IdConfiguration {
    client_id: string;
    callback: (response: CredentialResponse) => void;
    auto_select?: boolean;
    cancel_on_tap_outside?: boolean;
    ux_mode?: "popup" | "redirect";
    itp_support?: boolean;
    use_fedcm_for_prompt?: boolean;
  }

  interface GsiButtonConfiguration {
    type?: "standard" | "icon";
    theme?: "outline" | "filled_blue" | "filled_black";
    size?: "large" | "medium" | "small";
    text?: "signin_with" | "signup_with" | "continue_with" | "signin";
    shape?: "rectangular" | "pill" | "circle" | "square";
    logo_alignment?: "left" | "center";
    width?: number | string;
    locale?: string;
  }

  function initialize(config: IdConfiguration): void;
  function renderButton(parent: HTMLElement, options: GsiButtonConfiguration): void;
  function prompt(): void;
  function disableAutoSelect(): void;
}

interface Window {
  google?: { accounts: { id: typeof google.accounts.id } };
}
