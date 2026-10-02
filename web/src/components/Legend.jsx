import React from 'react';

export default function Legend() {
  return (
    <ul className="legend" aria-label="What the block colours mean">
      <li><span className="sw ok" aria-hidden="true" />On track</li>
      <li><span className="sw tight" aria-hidden="true">!</span>Near breach</li>
      <li><span className="sw breach" aria-hidden="true">!!</span>Breach risk</li>
      <li><span className="sw started" aria-hidden="true" />In progress</li>
      <li><span className="sw sent" aria-hidden="true">✓</span>Response sent</li>
      <li><span className="sw dl" aria-hidden="true"><i /></span>Response deadline</li>
      <li><span className="sw off" aria-hidden="true" />Off shift</li>
    </ul>
  );
}
