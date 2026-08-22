import { reactive, inject } from 'vue';
import type { InjectionKey } from 'vue';
import { authStatus, login, logout } from './api';

export type AuthState = 'checking' | 'need-password' | 'need-login' | 'ok';

/** ---- 登录态：未配密码 → 提示去配置文件 / 配了未登录 → 登录表单 / 已登录 → 编辑界面 ----
 *  登录成功后回调 onReady（拉取配置进入编辑态）。返回 reactive 对象，供 App 与 AuthCards 共享。 */
export function createAuth(onReady: () => Promise<void>) {
  const auth = reactive({
    state: 'checking' as AuthState,
    configPath: 'config.json',
    password: '',
    error: '',
    busy: false,
    async checkAuth(): Promise<void> {
      try {
        const st = await authStatus();
        auth.configPath = st.configPath;
        if (st.loggedIn) {
          auth.state = 'ok';
          await onReady();
        } else if (!st.passwordConfigured) {
          auth.state = 'need-password';
        } else {
          auth.state = 'need-login';
        }
      } catch {
        auth.state = 'need-login';
      }
    },
    /** 提交登录表单 */
    async submit(): Promise<void> {
      auth.busy = true;
      auth.error = '';
      try {
        await login(auth.password);
        auth.password = '';
        await auth.checkAuth();
      } catch (e) {
        auth.error = (e as Error).message;
      } finally {
        auth.busy = false;
      }
    },
    /** 登出：忽略后端错误，前端直接回到登录页 */
    async signOut(): Promise<void> {
      try {
        await logout();
      } catch {
        // 忽略，前端直接回到登录页
      }
      auth.state = 'need-login';
    },
  });
  return auth;
}

export type Auth = ReturnType<typeof createAuth>;

export const authKey: InjectionKey<Auth> = Symbol('auth');

/** 子组件（AuthCards 等）取登录态 */
export function useAuth(): Auth {
  const a = inject(authKey);
  if (!a) throw new Error('auth store 未 provide（需在 App.vue setup 中 createAuth + provide）');
  return a;
}
