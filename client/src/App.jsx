import { useEffect, useState } from 'react';
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

const TOPICS = ['HCF', 'PCT', 'INT', 'ALG', 'GEO', 'SET', 'PROB', 'PHY', 'CHEM', 'BIO', 'EARTH'];

export default function App() {
  const [questions, setQuestions] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch('/api/questions')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setQuestions)
      .catch((e) => setError(e.message));
  }, []);

  const perTopic = TOPICS.map((t) => ({ topic: t, count: questions?.filter((q) => q.topic === t).length ?? 0 }));

  return (
    <main>
      <h1>Abhyaas</h1>
      <p className="sub">SEE maths and science practice on any phone</p>
      {error && <p className="error">Could not load questions: {error}</p>}
      {questions && (
        <>
          <h2>Question bank ({questions.length})</h2>
          <div className="chart">
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={perTopic}>
                <XAxis dataKey="topic" />
                <YAxis allowDecimals={false} width={30} />
                <Tooltip />
                <Bar dataKey="count" fill="#2f6f4f" />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <ul className="questions">
            {questions.map((q) => (
              <li key={q.id}>
                <pre>{q.sms}</pre>
                <span className="answer">Answer: {q.correct_option} · {q.status}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
