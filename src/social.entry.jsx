import React from 'react';
import { createRoot } from 'react-dom/client';
import SocialProfile from './SocialProfile.jsx';

// Uygulama kabuğundan çağrılır: window.MotoSocial.mount(el, { me, socket, theme, onUnread })
window.MotoSocial = {
  mount(el, props) {
    const root = createRoot(el);
    root.render(<SocialProfile {...props} />);
    return { update: p => root.render(<SocialProfile {...p} />), unmount: () => root.unmount() };
  }
};
