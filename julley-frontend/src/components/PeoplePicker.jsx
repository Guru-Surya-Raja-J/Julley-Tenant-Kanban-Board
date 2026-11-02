import { useId, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { Avatar } from './ui.jsx';

const DEBOUNCE_MS = 150;

function Highlighted({ text, match }) {
  const index = text.toLowerCase().indexOf(match.toLowerCase());
  if (!match || index < 0) return text;
  return (
    <>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + match.length)}</mark>
      {text.slice(index + match.length)}
    </>
  );
}

/**
 * An email field that suggests people from the organization as you type. Free text
 * still works, because someone from outside can be added by their exact email.
 */
export function PeoplePicker({ value, onChange, searchPath, label }) {
  const [results, setResults] = useState(null); // null: list closed
  const [active, setActive] = useState(-1);
  const timer = useRef(null);
  const latest = useRef(0);
  const listId = useId();
  const typed = value.trim();

  const close = () => {
    clearTimeout(timer.current);
    latest.current += 1; // a response still in flight must not reopen the list
    setResults(null);
    setActive(-1);
  };

  const search = (text) => {
    clearTimeout(timer.current);
    const query = text.trim();
    if (!query) {
      close();
      return;
    }
    timer.current = setTimeout(async () => {
      const request = ++latest.current;
      try {
        const { people } = await api.get(`${searchPath}?q=${encodeURIComponent(query)}`);
        if (request === latest.current) {
          setResults(people);
          setActive(-1);
        }
      } catch {
        if (request === latest.current) setResults(null);
      }
    }, DEBOUNCE_MS);
  };

  const choose = (person) => {
    onChange(person.email);
    close();
  };

  const onKeyDown = (event) => {
    if (results === null) return;
    if (event.key === 'Escape') {
      // Close the list, not the dialog around it.
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'ArrowDown' && results.length) {
      event.preventDefault();
      setActive((active + 1) % results.length);
    } else if (event.key === 'ArrowUp' && results.length) {
      event.preventDefault();
      setActive((active - 1 + results.length) % results.length);
    } else if (event.key === 'Enter' && active >= 0) {
      event.preventDefault();
      choose(results[active]);
    }
  };

  return (
    <div className="picker">
      <input
        required
        type="email"
        role="combobox"
        autoComplete="off"
        placeholder="Name or email"
        aria-label={label}
        aria-expanded={results !== null}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          search(event.target.value);
        }}
        onKeyDown={onKeyDown}
        onBlur={close}
      />
      {results !== null && (
        <div className="picker-popup" data-testid="people-results">
          <ul id={listId} role="listbox" aria-label="Matching people">
            {results.map((person, index) => (
              <li
                key={person.id}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === active}
                className={index === active ? 'is-active' : ''}
                // Before the input's blur, which would close the list first.
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(person);
                }}
                onMouseEnter={() => setActive(index)}
              >
                <Avatar name={person.name} color={person.color} size="sm" />
                <span>
                  <Highlighted text={person.name} match={typed} />
                  <small><Highlighted text={person.email} match={typed} /></small>
                </span>
              </li>
            ))}
          </ul>
          {!results.length && (
            <p className="picker-empty">
              No one in this organization matches. To add someone from outside it, enter their full email.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
